/** Historypin source adapter (background trickle harvest, no API key).
 *
 * The request path never touches Historypin: a worker (see
 * `scheduleHistorypinWorker` below) runs small paced steps — one /pins/
 * list fetch (12 cards, random page of the filtered total) + a few detail
 * fetches for unseen cards — into `tinder_pool`. Decided rows are excluded
 * at both levels (pin ids and images); undecided pool rows stay servable.
 *
 * NOTE: the documented Historypin v7 API (/en/api/...) is retired (404).
 * This harvester scrapes the live site's server-rendered pages instead.
 * Historypin blurbs are English upstream, so there is no translation step.
 */
import type { Db, TinderPoolRow } from "../db.js";
import {
  poolDecadeHistogram,
  tinderExcludeKeys,
  tinderExcludedQids,
  tinderPoolInsert,
} from "../db.js";
import {
  buildBaseCard,
  dateDisplay,
  DECADE_BUCKETS,
  shortHash,
  shuffle,
  type DecadeBucket,
  type SourceAdapter,
  type SourceCard,
  type TinderCard,
} from "./types.js";

/** Significance bias: famous subjects are overrepresented by design.
 * Used as Historypin keyword queries, alternating with broad sampling. */
export const HP_KEYWORDS = [
  "battle", "earthquake", "election", "olympic games", "assassination",
  "revolution", "siege", "explosion", "parade", "coronation", "festival",
  "flood", "fire", "wedding", "football", "railway",
];
let keywordCursor = Math.floor(Math.random() * (HP_KEYWORDS.length + 1));

/** Next query: broad decade sampling every (N+1)th call, else a keyword. */
export function nextKeyword(): string | null {
  const slot = keywordCursor++ % (HP_KEYWORDS.length + 1);
  return slot === HP_KEYWORDS.length ? null : (HP_KEYWORDS[slot] ?? null);
}

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) DodocoHelper-tinder/1.0";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Paced text fetch with a tiny cookie jar (Cloudflare-friendly):
 *  ~700ms spacing, retries on network/5xx, fast fail on 4xx. */
const cookies = new Map<string, string>();
let lastFetchAt = 0;
async function hpGetText(url: string, timeoutMs = 20000, tries = 3): Promise<string> {
  let backoff = 2000;
  for (let a = 0; ; a++) {
    const wait = 700 - (Date.now() - lastFetchAt);
    if (wait > 0) await sleep(wait);
    lastFetchAt = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      const jar = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
      res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          "User-Agent": UA,
          Accept: "text/html",
          "Accept-Language": "en",
          ...(jar ? { Cookie: jar } : {}),
        },
      });
    } catch (e) {
      clearTimeout(timer);
      if (a >= tries - 1) throw e;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 10000);
      continue;
    }
    clearTimeout(timer);
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const m = /^([^=;]+)=([^;]*)/.exec(sc);
      if (m) cookies.set(m[1]!.trim(), m[2]!.trim());
    }
    if (res.ok) return await res.text();
    await res.arrayBuffer().catch(() => null);
    if ((res.status === 429 || res.status >= 500) && a < tries - 1) {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 10000);
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url.slice(0, 100)}`);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** First plausible year in a Historypin date string.
 *  Handles `1921`, `D. 1953`, `1915 - 1918`, `c. 1939-1956`. */
export function parsePinYear(s: string): number | null {
  const m = /\b(1[0-9]{3}|20[0-2][0-9])\b/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  if (!Number.isInteger(y) || y < 1400 || y > 2026) return null;
  return y;
}

export function isPinId(v: string): boolean {
  return /^hp:\d+$/.test(v);
}

export interface HpListCard {
  pinId: number;
  title: string;
  dateText: string;
  thumb: string;
}

export interface HpSearchResult {
  cards: HpListCard[];
  total: number;
}

/** One /pins/ list page: image pins in a date range, optional keyword. */
export async function historypinSearch(opts: {
  from: number;
  to: number;
  query?: string | null;
  page?: number;
}): Promise<HpSearchResult> {
  const q = new URLSearchParams({
    primary_media_type: "image",
    start_date: `${opts.from}-01-01`,
    end_date: `${Math.min(opts.to, 2026)}-12-31`,
    pins_page: String(opts.page ?? 1),
  });
  if (opts.query) q.set("search_query", opts.query);
  const html = await hpGetText(`https://www.historypin.org/pins/?${q.toString()}`);
  const cards: HpListCard[] = [];
  for (const chunk of html.split('id="pin-card-').slice(1)) {
    const idM = /^(\d+)/.exec(chunk);
    if (!idM) continue;
    const body = chunk.slice(0, 6000);
    const titleM = /pin-card-title">([^<]*)</.exec(body);
    const dateM = /pin-card-date">([^<]*)</.exec(body);
    const imgM = /<img src="([^"]+)"/.exec(body);
    if (!titleM || !imgM) continue;
    cards.push({
      pinId: Number(idM[1]),
      title: stripTags(titleM[1] ?? "").slice(0, 140) || `Pin ${idM[1]}`,
      dateText: stripTags(dateM?.[1] ?? ""),
      thumb: imgM[1]!,
    });
  }
  const totalM = /Showing \d+-\d+ of ~?([\d,]+) results/.exec(html);
  return { cards, total: totalM ? Number(totalM[1]!.replace(/,/g, "")) : cards.length };
}

export interface HpPinDetail {
  pinId: number;
  title: string;
  description: string;
  year: number | null;
  lat: number | null;
  lon: number | null;
  /** Best URL (upgraded rendition). */
  image: string;
  /** Embedded original: fallback when the upgrade flakes at display time. */
  fallbackImage: string | null;
  license: string;
}

/** Full metadata for one pin from its detail page. */
export async function historypinPinDetail(pinId: number): Promise<HpPinDetail | null> {
  let html: string;
  try {
    html = await hpGetText(`https://www.historypin.org/pins/${pinId}/`);
  } catch {
    return null;
  }
  const sec = (re: RegExp): string => {
    const m = re.exec(html);
    return m ? stripTags(m[1] ?? "") : "";
  };
  const title = sec(/<h1 class="pin-detail-title">([\s\S]*?)<\/h1>/) || `Pin ${pinId}`;
  const dateText = sec(/pin-detail-date"[^>]*>([\s\S]*?)<\/p>/);
  // Mobile full disclosure preferred; desktop truncated holds the full text too.
  const desc =
    sec(/disclosure-content-full"[\s\S]*?>([\s\S]*?)<\/div>/) ||
    sec(/disclosure-content-truncated"[\s\S]*?>([\s\S]*?)<\/div>/);
  const latM = /data-latitude="([^"]+)"\s+data-longitude="([^"]+)"/.exec(html);
  const imgM =
    /pin-detail-image"[\s\S]{0,400}?src="([^"]+)"/.exec(html) ??
    /data-overlay-image="([^"]+)"/.exec(html);
  const license = sec(/metadata-license"[\s\S]*?pin-metadata-value">([\s\S]*?)<\/div>/);
  const lat = latM ? Number(latM[1]) : NaN;
  const lon = latM ? Number(latM[2]) : NaN;
  const rawImage = (imgM?.[1] ?? "").replace(/&amp;/g, "&");
  if (!rawImage || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // Candidates: embedded URL + flipped size. First HEAD-ok wins, a second
  // rides along as display fallback. Verdict on status only: empty-200s
  // are bypassable cache poisoning (see freshUrl), not dead files.
  const flipped = flippedSize(rawImage);
  const candidates = flipped && flipped !== rawImage ? [rawImage, flipped] : [rawImage];
  const usable: string[] = [];
  for (const u of candidates) {
    if (!usable.includes(u) && (await imageUsable(u))) usable.push(u);
  }
  if (usable.length === 0) return null;
  const image = usable[0]!;
  const fallback = usable.find((u) => u !== image) ?? null;
  return {
    pinId,
    title: title.slice(0, 140),
    description: desc,
    year: parsePinYear(dateText),
    lat: Math.round(lat * 1000) / 1000,
    lon: Math.round(lon * 1000) / 1000,
    image,
    fallbackImage: fallback,
    license: license || "see Historypin pin page",
  };
}

const LICENSE_BLOCK = /all rights reserved/i;

/** Stable cache-key suffix for CDN display URLs. Cloudflare serves
 *  poisoned empty-200 objects for some bare keys (24h TTL); the same file
 *  under this key serves healthy bytes (origin ignores the param). One
 *  constant key per image: no rotation, no cache explosion. */
export const CDN_FRESH = "?hp=1";

export function freshUrl(url: string): string {
  if (!url.includes("media.historypin.org") || url.includes("?")) return url;
  return `${url}${CDN_FRESH}`;
}

async function headOk(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(url, { method: "HEAD", signal: ctrl.signal, headers: { "User-Agent": UA } });
      await res.arrayBuffer().catch(() => null);
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** Usable = HEAD ok directly or under the fresh cache key. */
export async function imageUsable(url: string): Promise<boolean> {
  if (!url.startsWith("http")) return false;
  if (await headOk(url)) return true;
  const fresh = freshUrl(url);
  return fresh !== url && (await headOk(fresh));
}

/** The other standard rendition: big <-> card-list thumb. */
export function flippedSize(url: string): string | null {
  if (/t-image-1000x1000-60-None---0\.jpg/i.test(url)) {
    return url.replace(/\/t-image-\d+x\d+-[^/]+\.jpg/i, "/t-image-320x300-50-1---0.jpg");
  }
  if (/t-image-320x300-/i.test(url)) {
    return url.replace(/\/t-image-\d+x\d+-[^/]+\.jpg/i, "/t-image-1000x1000-60-None---0.jpg");
  }
  return null;
}

/** Legacy CardInput shape (pinId-named). Kept for `server/tinder.ts`
 *  compatibility; new code prefers `SourceCard`. */
export interface CardInput {
  pinId: string;
  title: string;
  image: string;
  fallbackImage?: string | null;
  sourceImage: string;
  year: number;
  lat: number;
  lon: number;
  page: string;
  license: string;
  blurb: string;
  subjectTypes?: string | null;
}

function toSource(row: CardInput): SourceCard {
  return {
    sourceId: row.pinId,
    title: row.title,
    image: row.image,
    fallbackImage: row.fallbackImage,
    sourceImage: row.sourceImage,
    year: row.year,
    lat: row.lat,
    lon: row.lon,
    page: row.page,
    license: row.license,
    blurb: row.blurb,
    subjectTypes: row.subjectTypes,
  };
}

export function toCard(row: CardInput): TinderCard {
  const base = buildBaseCard(toSource(row));
  // Display URLs get the fresh cache key (bypasses poisoned CDN objects);
  // sourceImage stays raw so votes match the stored dedupe key.
  // id embeds the raw sourceImage hash (same as the shared builder).
  return {
    ...base,
    id: `${row.pinId}-${row.year}-${shortHash(row.sourceImage)}`,
    image: freshUrl(row.image),
    fallbackImage: row.fallbackImage ? freshUrl(row.fallbackImage) : null,
  };
}

/** One harvest step: list search (random page of the filtered total) ->
 *  detail fetches for the top unseen cards -> pool. Returns rows inserted.
 *  Paced and small by design (safety over quantity): ~1 list fetch +
 *  a few detail fetches per step. */
export async function harvestHistorypinStep(
  db: Db,
  bucket: DecadeBucket,
  query: string | null,
  detailsPerStep = 4,
): Promise<number> {
  const first = await historypinSearch({ from: bucket.from, to: bucket.to, query, page: 1 });
  const totalPages = Math.max(1, Math.min(4000, Math.ceil(first.total / 12)));
  const page = totalPages <= 1 ? 1 : 1 + Math.floor(Math.random() * totalPages);
  const list = page === 1 ? first : await historypinSearch({
    from: bucket.from, to: bucket.to, query, page,
  });
  // Decided rows are excluded at both levels: qids (this source dedupes by
  // pin) and images (a pin re-hosted under a new id still matches its file).
  const excludedImages = tinderExcludeKeys(db);
  const excludedQids = tinderExcludedQids(db);
  const fresh = shuffle(
    list.cards.filter((c) => !excludedQids.has(`hp:${c.pinId}`)),
  ).slice(0, detailsPerStep);
  // Three concurrent detail workers: detail pages are independent GETs
  // (browsers do 6+); list fetches stay strictly sequential + paced.
  const rows: TinderPoolRow[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < fresh.length) {
      const c = fresh[cursor++]!;
      const d = await historypinPinDetail(c.pinId);
      if (!d || d.year === null) continue;
      if (LICENSE_BLOCK.test(d.license)) continue;
      const key = `hp:${d.pinId}`;
      if (excludedQids.has(key) || excludedImages.has(d.image)) continue;
      rows.push({
        qid: key,
        image: d.image,
        title: d.title,
        label: d.title,
        description: d.description,
        descLang: "en",
        year: d.year,
        lat: d.lat!,
        lon: d.lon!,
        page: `https://www.historypin.org/pins/${d.pinId}/`,
        thumb: d.fallbackImage ?? d.image,
        license: d.license,
        source: "historypin",
        dateKind: "depicted",
        datePrecision: 0,
        article: "",
        fileUsage: "",
      });
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  if (rows.length === 0) return 0;
  return tinderPoolInsert(db, rows);
}

export const historypinAdapter: SourceAdapter = {
  key: "historypin",
  isSourceId: isPinId,
  nextQuery: nextKeyword,
  harvestStep: harvestHistorypinStep,
  toCard(row: SourceCard): TinderCard {
    const card = toCard({
      pinId: row.sourceId,
      title: row.title,
      image: row.image,
      fallbackImage: row.fallbackImage,
      sourceImage: row.sourceImage,
      year: row.year,
      lat: row.lat,
      lon: row.lon,
      page: row.page,
      license: row.license,
      blurb: row.blurb,
      subjectTypes: row.subjectTypes,
    });
    // The legacy builder only knows pin-shaped rows: carry the
    // source-neutral provenance through so the UI can show it.
    card.dateKind = row.dateKind ?? "";
    if (row.blurbSource) card.blurbSource = row.blurbSource;
    if (row.article) card.article = row.article;
    // Tags were computed from a subject-less legacy shape: recompute with
    // the row's real provenance (HP rows carry no subject types → generic).
    const dd = dateDisplay(row.dateKind, row.subjectTypes);
    card.dateTag = dd.tag;
    card.dateHint = dd.hint;
    return card;
  },
  exportId(eventQid: string, year: number): string {
    return `hp-${eventQid.replace(/^hp:/, "")}-${year}`;
  },
};

export interface HistorypinWorkerOptions {
  detailsPerStep?: number;
  /** Skip the tick when every decade already holds this many HP pool rows. */
  poolTarget?: number;
}

/** Background trickle worker: one small paced step per tick against the
 *  thinnest Historypin decade (skipped when the pool is healthy).
 *  Never throws; concurrent ticks are skipped, never stacked. */
export function scheduleHistorypinWorker(
  db: Db,
  intervalMs: number,
  opts: HistorypinWorkerOptions = {},
): () => void {
  const ms = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 10 * 60 * 1000;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        const hist = poolDecadeHistogram(db, "hp");
        let bi = 0;
        for (let i = 1; i < hist.length; i++) {
          if ((hist[i] ?? 0) < (hist[bi] ?? 0)) bi = i;
        }
        if ((hist[bi] ?? 0) >= (opts.poolTarget ?? 30)) return;
        const bucket = DECADE_BUCKETS[bi]!;
        await harvestHistorypinStep(db, bucket, nextKeyword(), opts.detailsPerStep ?? 4);
      } catch {
        // Background worker must never crash the server.
      } finally {
        running = false;
      }
    })();
  }, ms);
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  return () => clearInterval(timer);
}
