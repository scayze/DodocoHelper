/** Wikidata enrichment: candidates → `tinder_pool` rows.
 *
 * Batched high-limit APIs only (no SPARQL here):
 *  1. `wbgetentities` (≤50 QIDs/call): label, description, P18 filename,
 *     P625 coords, date claims (P571/P580/P585/P577), enwiki sitelink.
 *  2. Commons `imageinfo|globalusage` (batched): resolvable thumb, license
 *     gate, and the file's Wikipedia footprint.
 *  3. Wikipedia `page/summary` (per item, only when the WD description is
 *     a fragment): 1–2 sentence blurb, CC BY-SA attributed via blurbSource.
 *
 * Provenance is persisted per row: the winning date property + precision
 * (`date_kind`), the subject article, and the file usage list.
 */
import type { Db } from "../../db.js";
import { tinderExcludeKeys, tinderPoolInsert } from "../../db.js";
import { ensureCandidateTables } from "./discovery.js";
import {
  claimCoord,
  commonsLicense,
  fileTitleFor,
  pickBlurb,
  preferredDateClaim,
  usageForFile,
  type FileUsage,
  type WbDateClaim,
} from "./map.js";
import { API_POLITE, politeGetJson, UpstreamBusyError } from "./polite.js";

const DATE_PROPS = ["P571", "P580", "P585", "P577"];

interface WbEntitiesJson {
  entities?: Record<string, {
    labels?: Record<string, { value?: string }>;
    descriptions?: Record<string, { value?: string }>;
    sitelinks?: Record<string, { title?: string }>;
    claims?: Record<string, Array<{
      mainsnak?: { datavalue?: { value?: unknown } };
    }>>;
  }>;
}

interface CommonsJson {
  query?: {
    pages?: Record<string, {
      title?: string;
      imageinfo?: Array<{
        thumburl?: string;
        url?: string;
        extmetadata?: Record<string, { value?: string }>;
      }>;
      globalusage?: FileUsage[];
    }>;
  };
}

interface SummaryJson {
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function labelOf(e: NonNullable<WbEntitiesJson["entities"]>[string]): string {
  return e.labels?.["en"]?.value?.trim() || "";
}

function descOf(e: NonNullable<WbEntitiesJson["entities"]>[string]): string {
  return e.descriptions?.["en"]?.value?.trim() || "";
}

function articleOf(e: NonNullable<WbEntitiesJson["entities"]>[string]): string {
  return e.sitelinks?.["enwiki"]?.title?.trim() || "";
}

/** P31 subject-type QIDs (up to 5), persisted for display wording. */
function typeIdsOf(e: NonNullable<WbEntitiesJson["entities"]>[string]): string[] {
  const out: string[] = [];
  for (const c of e.claims?.["P31"] ?? []) {
    const v = c.mainsnak?.datavalue?.value as { id?: unknown } | undefined;
    if (typeof v?.id === "string" && /^Q\d+$/.test(v.id) && !out.includes(v.id)) {
      out.push(v.id);
    }
    if (out.length >= 5) break;
  }
  return out;
}

function p18File(e: NonNullable<WbEntitiesJson["entities"]>[string]): string | null {
  const v = e.claims?.["P18"]?.[0]?.mainsnak?.datavalue?.value;
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function dateClaimsOf(e: NonNullable<WbEntitiesJson["entities"]>[string]): WbDateClaim[] {
  const out: WbDateClaim[] = [];
  for (const p of DATE_PROPS) {
    for (const c of e.claims?.[p] ?? []) {
      const v = c.mainsnak?.datavalue?.value as
        | { time?: unknown; precision?: unknown }
        | undefined;
      if (typeof v?.time === "string" && typeof v?.precision === "number") {
        out.push({ property: p, time: v.time, precision: v.precision });
      }
    }
  }
  return out;
}

function coordOf(e: NonNullable<WbEntitiesJson["entities"]>[string]): { lat: number; lon: number } | null {
  return claimCoord(e.claims?.["P625"]?.[0]?.mainsnak?.datavalue?.value);
}

async function fetchEntities(ids: string[]): Promise<WbEntitiesJson> {
  const url =
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids.join("|")}` +
    `&props=labels|descriptions|claims|sitelinks&languages=en&languagefallback=1&format=json&origin=*`;
  return politeGetJson<WbEntitiesJson>(url, { ...API_POLITE, channel: "wd-api" });
}

async function fetchCommons(files: string[]): Promise<CommonsJson> {
  const titles = files.map((f) => fileTitleFor(f)).join("|");
  const url =
    `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(titles)}` +
    `&prop=imageinfo|globalusage&iiprop=url|size|extmetadata&iiurlwidth=1000` +
    `&gunamespace=0&gulimit=10&format=json&origin=*`;
  return politeGetJson<CommonsJson>(url, { ...API_POLITE, channel: "commons-api" });
}

async function fetchSummary(title: string): Promise<SummaryJson | null> {
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`;
    return await politeGetJson<SummaryJson>(url, { ...API_POLITE, channel: "wiki-api" });
  } catch {
    return null;
  }
}

export interface EnrichResult {
  inserted: number;
  dead: number;
}

function markCandidate(db: Db, qid: string, state: "enriched" | "dead"): void {
  if (state === "dead") {
    db.prepare(
      `UPDATE wd_candidates SET state = 'dead', fail_count = fail_count + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE qid = ?`,
    ).run(qid);
  } else {
    db.prepare(
      `UPDATE wd_candidates SET state = 'enriched',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE qid = ?`,
    ).run(qid);
  }
}

interface FileAssets {
  image: string;
  fallback: string;
  license: string;
  ok: boolean;
  usage: FileUsage[];
}

/** Enrich up to `batch` `new` candidates (oldest buckets first).
 *  Returns counts; never throws for routine upstream trouble. */
export async function enrichCandidates(db: Db, batch = 20): Promise<EnrichResult> {
  ensureCandidateTables(db);
  const out: EnrichResult = { inserted: 0, dead: 0 };
  const cands = db
    .prepare(
      `SELECT qid, year, lat, lon FROM wd_candidates
       WHERE state = 'new' AND fail_count < 3
       ORDER BY bucket ASC, updated_at ASC LIMIT ?`,
    )
    .all(batch) as unknown as Array<{ qid: string; year: number; lat: number; lon: number }>;
  if (cands.length === 0) return out;
  const excluded = tinderExcludeKeys(db);

  for (const group of chunk(cands, 10)) {
    let entities: WbEntitiesJson;
    try {
      entities = await fetchEntities(group.map((c) => c.qid.replace(/^wd:/, "")));
    } catch (e) {
      if (e instanceof UpstreamBusyError) return out;
      continue; // leave state=new for retry; fail_count untouched
    }
    const files = group.map((c) => {
      const q = c.qid.replace(/^wd:/, "");
      return p18File(entities.entities?.[q] ?? ({} as never));
    });
    let commons: CommonsJson = {};
    const wanted = [...new Set(files.filter((f): f is string => !!f))];
    if (wanted.length > 0) {
      try {
        commons = await fetchCommons(wanted);
      } catch (e) {
        if (e instanceof UpstreamBusyError) return out;
        commons = {};
      }
    }
    const pages = commons.query?.pages ?? {};
    const assetsFor = (file: string): FileAssets | null => {
      // Match the page by canonical file title (robust across URL
      // variants); fall back to any single page when unambiguous.
      const keys = Object.keys(pages);
      const hit = keys.find((k) => {
        const t = pages[k]?.title ?? "";
        return t.replace(/^File:/i, "").replace(/_/g, " ").trim().toLowerCase() ===
          file.replace(/^File:/i, "").replace(/_/g, " ").trim().toLowerCase();
      }) ?? (keys.length === 1 ? keys[0] : undefined);
      const page = hit !== undefined ? pages[hit] : undefined;
      const info = page?.imageinfo?.[0];
      if (!info?.url) return null;
      const lic = commonsLicense([
        info.extmetadata?.["LicenseShortName"]?.value,
        info.extmetadata?.["UsageTerms"]?.value,
        info.extmetadata?.["Copyrighted"]?.value,
      ]);
      return {
        image: info.thumburl || info.url,
        fallback: info.url,
        license: lic.license,
        ok: lic.ok,
        usage: usageForFile(pages, file),
      };
    };

    const poolRows: Parameters<typeof tinderPoolInsert>[1] = [];
    for (let i = 0; i < group.length; i++) {
      const c = group[i]!;
      const q = c.qid.replace(/^wd:/, "");
      const e = entities.entities?.[q];
      if (!e) continue; // retry later
      const label = labelOf(e);
      const claims = dateClaimsOf(e).slice(0, 20);
      const win = preferredDateClaim(claims);
      const article = articleOf(e);
      const tids = typeIdsOf(e);
      const subjectTypes = tids.length > 0 ? JSON.stringify(tids) : "";
      // Hardfilter, verified against live data (QLever snapshots can be
      // stale): no English article → dead. Date claims that exist but are
      // all coarser than year precision (e.g. century) → dead: the game
      // needs a real year, and the candidate year comes from those same
      // imprecise statements. The candidate-year fallback below survives
      // only for the defensive case of zero date claims at all.
      if (!article) {
        markCandidate(db, c.qid, "dead");
        out.dead++;
        continue;
      }
      if (!win && claims.length > 0) {
        markCandidate(db, c.qid, "dead");
        out.dead++;
        continue;
      }
      const year = win?.year ?? (c.year >= 1400 ? c.year : null);
      const dateKind = win?.property ?? "";
      const datePrecision = win?.precision ?? 0;
      const coord = coordOf(e) ?? (Number.isFinite(c.lat) && Number.isFinite(c.lon)
        ? { lat: c.lat, lon: c.lon } : null);
      const file = files[i];
      if (!label || year === null || !coord || !file) {
        markCandidate(db, c.qid, "dead");
        out.dead++;
        continue;
      }
      const assets = assetsFor(file);
      if (!assets || !assets.ok || !assets.image.startsWith("http")) {
        markCandidate(db, c.qid, "dead");
        out.dead++;
        continue;
      }
      if (excluded.has(assets.image) || excluded.has(assets.fallback)) {
        markCandidate(db, c.qid, "dead");
        out.dead++;
        continue;
      }
      const desc = descOf(e);
      let blurb = pickBlurb({ description: desc, label });
      let blurbSource = `https://commons.wikimedia.org/wiki/${encodeURIComponent(fileTitleFor(file).replace(/ /g, "_"))}`;
      if ((blurb === null || blurb === label) && article) {
        const sum = await fetchSummary(article);
        const better = pickBlurb({ description: desc, wikiExtract: sum?.extract, label });
        if (better && better !== label) {
          blurb = better;
          blurbSource = sum?.content_urls?.desktop?.page
            ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(article.replace(/ /g, "_"))}`;
        }
      }
      if (!blurb) {
        markCandidate(db, c.qid, "dead");
        out.dead++;
        continue;
      }
      poolRows.push({
        qid: c.qid,
        image: assets.image,
        title: label.slice(0, 140),
        label: label.slice(0, 140),
        description: blurb,
        descLang: "en",
        year,
        lat: coord.lat,
        lon: coord.lon,
        page: `https://www.wikidata.org/wiki/${q}`,
        thumb: assets.fallback,
        license: assets.license,
        blurbSource,
        source: "wikidata",
        subjectTypes,
        dateClaims: JSON.stringify(claims),
        dateKind,
        datePrecision,
        article,
        fileUsage: assets.usage.length > 0 ? JSON.stringify(assets.usage) : "",
      });
      markCandidate(db, c.qid, "enriched");
    }
    if (poolRows.length > 0) out.inserted += tinderPoolInsert(db, poolRows);
  }
  return out;
}
