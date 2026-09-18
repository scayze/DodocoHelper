#!/usr/bin/env node
// Snapshot dataset builder: photos only, links + metadata, no image bytes.
//
// Harvests Commons files with structured depicts (P180) + inception (P571),
// resolves depicted places via Wikidata, enriches via the Commons API
// (license/author/description/thumb), extracts a 1-2 sentence blurb
// (file description -> Wikipedia article fallback), scores, and emits:
//   - scripts/.cache/snapshot/review.html (eyeball gallery, gitignored)
//   - src/games/snapshot/items.ts (with --emit)
//
// Usage:
//   node scripts/fetch-snapshot.mjs --pages 8 --limit 200
//   node scripts/fetch-snapshot.mjs --pages 8 --limit 200 --emit
//   node scripts/fetch-snapshot.mjs --offline --emit   # reuse cache only
//
// Etiquette: paced requests, distinct User-Agent, maxlag respected.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const CACHE = path.join(HERE, ".cache", "snapshot");
const UA = "DodocoHelper-snapshot/1.0 (dataset builder; contact via repo)";
const PAUSE_MS = 1000;

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}
const PAGES = Number(flag("--pages", "8")) || 8;
const LIMIT = Number(flag("--limit", "200")) || 200;
const EMIT = args.includes("--emit");
const OFFLINE = args.includes("--offline");
const OUT_TS = path.join(ROOT, "src/games/snapshot/items.ts");

fs.mkdirSync(CACHE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(url, tries = 7) {
  if (OFFLINE) throw new Error("offline mode: refusing network");
  let wait = 8000;
  for (let a = 0; ; a++) {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.ok) {
      await sleep(PAUSE_MS);
      return res.json();
    }
    if ([429, 500, 502, 503, 504].includes(res.status) && a < tries - 1) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : wait);
      wait = Math.min(wait * 2, 30000);
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url.slice(0, 120)}`);
  }
}
const cacheGet = (name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(CACHE, name), "utf8"));
  } catch {
    return null;
  }
};
const cacheSet = (name, value) =>
  fs.writeFileSync(path.join(CACHE, name), JSON.stringify(value));

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ---------------------------------------------------------------- harvest
async function harvestSearch(pages) {
  const cached = cacheGet("search.json");
  if (cached) {
    console.log(`search: ${cached.length} files (cache)`);
    return cached;
  }
  const files = cacheGet("search.json") ?? [];
  let offset = files.length;
  for (let p = 0; files.length < pages * 500; p++) {
    const url =
      "https://commons.wikimedia.org/w/api.php?action=query&format=json" +
      "&list=search&srsearch=" +
      encodeURIComponent("filetype:bitmap haswbstatement:P180 haswbstatement:P571") +
      `&srnamespace=6&srlimit=500&sroffset=${offset}`;
    const body = await getJSON(url);
    const batch = (body?.query?.search ?? []).filter(
      (r) => !files.some((f) => f.pageid === r.pageid),
    );
    if (batch.length === 0) break;
    for (const r of batch) files.push({ title: r.title, pageid: r.pageid });
    console.log(`search: +${batch.length} (total ${files.length})`);
    cacheSet("search.json", files);
    if (!body?.continue) break;
    offset = body.continue.sroffset;
  }
  // Cheap filename pre-filter: drop obvious non-photos before spending API budget.
  const JUNK = /\b(logo|logos|icon|icons|diagram|diagrams|flag|flags|coat of arms|banknote|banknotes|stamp|stamps|poster|posters|chart|charts|screenshot|screenshots|scan|scans|blueprint|map|maps|plan d|ground plan|floor plan)\b/i;
  const kept = files.filter((f) => !JUNK.test(f.title.replace(/_/g, " ")));
  console.log(`search: ${files.length} raw, ${kept.length} after filename filter`);
  cacheSet("search.json", kept);
  return kept;
}

// ------------------------------------------------------- structured claims
async function fetchClaims(files) {
  const cached = cacheGet("claims.json");
  if (cached && Object.keys(cached).length > 0) {
    console.log(`claims: ${Object.keys(cached).length} files (cache)`);
    return cached;
  }
  // NOTE: wbgetclaims takes a single entity; batched MIDs go through
  // wbgetentities (plural), whose response nests claims per entity.
  const out = cacheGet("claims.json") ?? {};
  const done = new Set(Object.keys(out));
  const todo = files.filter((f) => !done.has(midOf(f.pageid)));
  const totalB = Math.max(1, Math.ceil(todo.length / 50));
  let n = 0;
  for (const group of chunk(todo, 50)) {
    const ids = group.map((f) => midOf(f.pageid)).join("|");
    const url =
      "https://commons.wikimedia.org/w/api.php?action=wbgetentities&format=json" +
      `&ids=${ids}&props=claims`;
    try {
      const body = await getJSON(url);
      for (const mid of Object.keys(body?.entities ?? {})) {
        // MediaInfo nests statements under `statements` (not `claims`).
        const claims = body.entities[mid]?.statements ?? body.entities[mid]?.claims ?? {};
        const depicts = (claims.P180 ?? [])
          .filter((c) => c.rank !== "deprecated")
          .map((c) => c.mainsnak?.datavalue?.value?.id)
          .filter(Boolean);
        const p571 = (claims.P571 ?? []).find((c) => c.rank !== "deprecated");
        let year = null;
        const t = p571?.mainsnak?.datavalue?.value;
        if (t && typeof t.time === "string" && (t.precision ?? 0) >= 9) {
          const y = Number(t.time.slice(0, 5));
          if (Number.isInteger(y) && y >= 1830 && y <= 2024) year = y;
        }
        if (depicts.length > 0 && year !== null) {
          out[mid] = { depicts: depicts.slice(0, 3), year };
        } else {
          out[mid] = null; // seen, unusable: don't refetch
        }
      }
    } catch (e) {
      console.log(`  claims batch failed (${String(e).slice(0, 80)}), continuing`);
    }
    n++;
    if (n % 5 === 0) cacheSet("claims.json", out);
    console.log(`  claims batch ${n}/${totalB}`);
  }
  cacheSet("claims.json", out);
  const usable = Object.values(out).filter((v) => v && v.depicts);
  console.log(`claims: ${usable.length} files with depicts+year`);
  for (const [k, v] of Object.entries(out)) if (v === null) delete out[k];
  return out;
}

// ------------------------------------------------------------- depicts info
async function fetchEntities(qids) {
  const cached = cacheGet("entities.json") ?? {};
  const missing = qids.filter((q) => !cached[q]);
  const totalEnt = Math.max(1, Math.ceil(missing.length / 50));
  let nEnt = 0;
  for (const group of chunk(missing, 50)) {
    const url =
      "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json" +
      `&ids=${group.join("|")}&props=labels|sitelinks|claims&languages=en&sitefilter=enwiki`;
    try {
      const body = await getJSON(url);
      for (const q of Object.keys(body?.entities ?? {})) {
        const e = body.entities[q];
        if (!e || e.missing) continue;
        const p31 = (e.claims?.P31 ?? [])
          .map((c) => c.mainsnak?.datavalue?.value?.id)
          .filter(Boolean);
        const coord = e.claims?.P625?.[0]?.mainsnak?.datavalue?.value ?? null;
        cached[q] = {
          label: e.labels?.en?.value ?? q,
          p31,
          lat: coord ? coord.latitude : null,
          lon: coord ? coord.longitude : null,
          sitelinks: Object.keys(e.sitelinks ?? {}).length,
          enwiki: e.sitelinks?.enwiki?.title ?? null,
        };
      }
    } catch (e) {
      console.log(`  entities batch failed (${String(e).slice(0, 80)}), continuing`);
    }
    nEnt++;
    if (nEnt % 5 === 0) cacheSet("entities.json", cached);
    console.log(`  entities batch ${nEnt}/${totalEnt}`);
  }
  cacheSet("entities.json", cached);
  return cached;
}

async function fetchP31Labels(qids) {
  const cached = cacheGet("p31labels.json") ?? {};
  const missing = [...new Set(qids)].filter((q) => !cached[q]);
  let nP31 = 0;
  for (const group of chunk(missing, 50)) {
    const url =
      "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json" +
      `&ids=${group.join("|")}&props=labels&languages=en`;
    try {
      const body = await getJSON(url);
      for (const q of Object.keys(body?.entities ?? {})) {
        cached[q] = body.entities[q]?.labels?.en?.value ?? q;
      }
    } catch (e) {
      console.log(`  p31 batch failed (${String(e).slice(0, 80)}), continuing`);
    }
    if (++nP31 % 5 === 0) cacheSet("p31labels.json", cached);
  }
  cacheSet("p31labels.json", cached);
  return cached;
}

const DENY_P31 = [
  "painting", "map", "diagram", "flag", "logo", "emblem", "coat of arms",
  "postage stamp", "banknote", "currency", "coin", "medal", "poster", "sign",
  "book", "manuscript", "document", "drawing", "print", "engraving",
  "textile", "clothing", "furniture", "musical instrument", "weapon", "tool",
  "toy", "software", "typeface", "font", "company", "organization",
  "business", "enterprise", "brand", "product",
];

// Depicts kinds that make the best guessing material (user brief:
// events, buildings). Matched against P31 labels.
const BONUS_P31 = [
  "fair", "festival", "exposition", "olympic", "exhibition", "ceremony",
  "competition", "championship", "battle", "war", "disaster", "earthquake",
  "construction", "museum", "church", "cathedral", "castle", "bridge",
  "tower", "station", "stadium", "palace", "temple", "hotel", "theatre",
  "theater", "airport", "harbour", "harbor", "monument", "memorial",
  "university", "square", "observatory", "lighthouse",
];

function depictsOk(info, p31labels) {
  if (!info || info.lat === null || !info.enwiki) return false;
  if (info.p31.includes("Q5")) return false; // person portraits: no where-basis
  for (const p of info.p31) {
    const label = (p31labels[p] ?? "").toLowerCase();
    if (DENY_P31.some((d) => label.includes(d))) return false;
  }
  return true;
}

// ------------------------------------------------------- commons enrich
function stripHtml(html) {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>\s*<(p|div|li)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const LANG_SPLIT =
  /\s+(Français|Deutsch|Español|Italiano|Nederlands|Polski|Русский|日本語|中文|Português|Svenska|Magyar|Čeština|Türkçe|العربية|한국어|Norsk|Dansk|Suomi|Română|Hrvatski|Українська|Ελληνικά|Català|Galego|Bahasa Indonesia|Tiếng Việt|עברית|हिन्दी)\s*:/;

function englishDesc(html) {
  const text = stripHtml(html);
  const m = text.match(/(?:^|\s)English\s*:\s*([\s\S]+)/);
  const en = m ? m[1].split(LANG_SPLIT)[0] : text.split(LANG_SPLIT)[0];
  return en.trim();
}

function sentences(text, maxChars) {
  const parts = String(text).match(/[^.!?]+[.!?]+/g) ?? [String(text)];
  let out = "";
  for (const s of parts.slice(0, 2)) {
    const next = (out ? out + " " : "") + s.trim();
    if (next.length > maxChars) break;
    out = next;
  }
  if (!out) out = String(text).slice(0, maxChars).trim();
  if (out.length >= maxChars) out = out.slice(0, maxChars).rsplitLastSpace() + "…";
  return out;
}

// String helper without polluting prototypes elsewhere.
String.prototype.rsplitLastSpace = function () {
  const i = this.lastIndexOf(" ");
  return i > 40 ? this.slice(0, i) : this.toString();
};

function cleanBlurb(raw, maxChars = 280) {
  const text = raw.trim();
  if (text.length < 40 || text.includes("{{") || text.includes("http")) return null;
  return sentences(text, maxChars);
}

/** Drop sentences naming the answer year (would give away the when-guess). */
function stripAnswerYear(text, year) {
  const parts = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  const kept = parts.filter((s) => !new RegExp(`\\b${year}\\b`).test(s));
  const out = kept.join(" ").trim();
  return out.length >= 40 ? out : null;
}

function licenseOk(shortName) {
  const t = stripHtml(shortName).toLowerCase();
  if (!t) return false;
  if (/nc|nd|non-?commercial|no deriv|sampling|copyrighted(?! free use)/.test(t)) {
    if (!/copyrighted free use/.test(t)) return false;
  }
  return /public domain|cc0|cc by\b|cc by-sa|copyrighted free use|\bpdm\b|pd-old|pd-us/.test(t);
}

async function fetchImageinfo(titles) {
  const cached = cacheGet("imageinfo.json") ?? {};
  const missing = titles.filter((t) => !cached[t]);
  const totalIi = Math.max(1, Math.ceil(missing.length / 50));
  let nIi = 0;
  for (const group of chunk(missing, 50)) {
    const url =
      "https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo" +
      `&titles=${encodeURIComponent(group.join("|"))}` +
      "&iiprop=url|size|sha1|extmetadata&iiurlwidth=800" +
      "&iiextmetadatafilter=ImageDescription|Artist|LicenseShortName";
    try {
      const body = await getJSON(url);
      for (const p of Object.values(body?.query?.pages ?? {})) {
        if (p.missing) continue;
        const ii = p.imageinfo?.[0];
        if (!ii) continue;
        cached[p.title] = {
          thumb: ii.thumburl ?? ii.url,
          page: ii.descriptionurl,
          width: ii.width ?? 0,
          sha1: ii.sha1 ?? null,
          descHtml: ii.extmetadata?.ImageDescription?.value ?? "",
          artist: stripHtml(ii.extmetadata?.Artist?.value ?? "").slice(0, 80),
          license: stripHtml(ii.extmetadata?.LicenseShortName?.value ?? ""),
        };
      }
    } catch (e) {
      console.log(`  imageinfo batch failed (${String(e).slice(0, 80)}), continuing`);
    }
    nIi++;
    if (nIi % 5 === 0) cacheSet("imageinfo.json", cached);
    console.log(`  imageinfo batch ${nIi}/${totalIi}`);
  }
  cacheSet("imageinfo.json", cached);
  return cached;
}

async function fetchExtracts(titles) {
  const cached = cacheGet("extracts.json") ?? {};
  const missing = [...new Set(titles)].filter((t) => t && !cached[t]);
  const totalEx = Math.max(1, Math.ceil(missing.length / 20));
  let nEx = 0;
  for (const group of chunk(missing, 20)) {
    const url =
      "https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts" +
      "&exintro&explaintext&exsentences=2" +
      `&titles=${encodeURIComponent(group.join("|"))}`;
    try {
      const body = await getJSON(url);
      for (const p of Object.values(body?.query?.pages ?? {})) {
        if (p.missing || !p.title) continue;
        cached[p.title] = (p.extract ?? "").trim().replace(/\s+/g, " ");
      }
    } catch (e) {
      console.log(`  extracts batch failed (${String(e).slice(0, 80)}), continuing`);
    }
    nEx++;
    if (nEx % 5 === 0) cacheSet("extracts.json", cached);
    console.log(`  extracts batch ${nEx}/${totalEx}`);
  }
  cacheSet("extracts.json", cached);
  return cached;
}

// ------------------------------------------------------- wikidata bonus
async function harvestWdPhotos() {
  const cached = cacheGet("wdphotos.json");
  if (cached) {
    console.log(`wd photos: ${cached.length} (cache)`);
    return cached;
  }
  const q = `SELECT ?item ?itemLabel ?image ?inception ?depicts WHERE {
  ?item wdt:P31 wd:Q125191 ; wdt:P18 ?image ; wdt:P571 ?inception ; wdt:P180 ?depicts .
  FILTER(YEAR(?inception) >= 1830 && YEAR(?inception) <= 2024)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 300`;
  try {
    const body = await getJSON(
      `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`,
    );
    const out = [];
    for (const b of body?.results?.bindings ?? []) {
      const file = decodeURIComponent(String(b.image?.value ?? "").split("/").pop() ?? "");
      const year = Number(String(b.inception?.value ?? "").slice(0, 5));
      const dq = String(b.depicts?.value ?? "").split("/").pop();
      if (file && Number.isInteger(year)) out.push({ file, year, depictsQid: dq });
    }
    console.log(`wd photos: ${out.length} raw`);
    cacheSet("wdphotos.json", out);
    return out;
  } catch (e) {
    console.log(`wd photos failed (${String(e).slice(0, 100)}), skipping source`);
    return [];
  }
}

// ------------------------------------------------------------------ main
const midOf = (pageid) => `M${pageid}`;
const titleOf = (mid, files) => files.find((f) => midOf(f.pageid) === mid)?.title;

async function main() {
  const files = await harvestSearch(PAGES);
  const claims = await fetchClaims(files);
  for (const [k, v] of Object.entries(claims)) {
    if (!v?.depicts) delete claims[k];
  }

  // Merge WDQS photo bonus into the same shape.
  const wdBonus = await harvestWdPhotos();
  const bonusByTitle = {};
  for (const b of wdBonus) {
    const title = "File:" + b.file.replaceAll(" ", "_");
    bonusByTitle[title] = b;
  }

  const allQids = new Set();
  for (const c of Object.values(claims)) for (const q of c.depicts) allQids.add(q);
  for (const b of wdBonus) if (b.depictsQid) allQids.add(b.depictsQid);
  const entities = await fetchEntities([...allQids]);
  const p31pool = new Set();
  for (const e of Object.values(entities)) for (const p of e.p31) p31pool.add(p);
  const p31labels = await fetchP31Labels([...p31pool]);

  // Assemble candidates: pick first depicts with coords + article.
  const fileByTitle = Object.fromEntries(files.map((f) => [f.title, f]));
  const cands = [];
  const seenSha = new Set();
  for (const [mid, c] of Object.entries(claims)) {
    const title = titleOf(mid, files);
    if (!title) continue;
    let dep = null;
    for (const q of c.depicts) {
      const info = entities[q];
      if (depictsOk(info, p31labels)) {
        dep = { qid: q, ...info };
        break;
      }
    }
    if (dep) cands.push({ title, year: c.year, dep });
  }
  console.log(`candidates after depicts filter: ${cands.length}`);

  const imageinfo = await fetchImageinfo(cands.map((c) => c.title));
  const withInfo = [];
  for (const c of cands) {
    const ii = imageinfo[c.title];
    if (!ii || !ii.thumb) continue;
    if (!licenseOk(ii.license)) continue;
    if ((ii.width ?? 0) < 640) continue;
    if (ii.sha1 && seenSha.has(ii.sha1)) continue;
    if (ii.sha1) seenSha.add(ii.sha1);
    withInfo.push({ ...c, ii });
  }
  console.log(`after license/size/dedupe: ${withInfo.length}`);

  // Blurbs: file description first, article extract fallback. Sentences
  // naming the answer year are stripped (would give away the when-guess).
  const needArticle = [];
  for (const c of withInfo) {
    const raw = cleanBlurb(englishDesc(c.ii.descHtml));
    const blurb = raw ? stripAnswerYear(raw, c.year) : null;
    c.blurb = blurb;
    c.blurbSource = blurb ? c.ii.page : null;
    if (!blurb && c.dep.enwiki) needArticle.push(c);
  }
  const extracts = await fetchExtracts(needArticle.map((c) => c.dep.enwiki));
  for (const c of needArticle) {
    const raw = cleanBlurb(extracts[c.dep.enwiki] ?? "");
    const blurb = raw ? stripAnswerYear(raw, c.year) : null;
    if (blurb) {
      c.blurb = blurb;
      c.blurbSource = `https://en.wikipedia.org/wiki/${encodeURIComponent(c.dep.enwiki.replaceAll(" ", "_"))}`;
    }
  }
  const withBlurb = withInfo.filter((c) => c.blurb);
  console.log(`with blurb: ${withBlurb.length}`);

  // Score + diversity select (two passes: decade-capped, then fill).
  const depBonus = (c) => {
    const labels = c.dep.p31.map((p) => (p31labels[p] ?? "").toLowerCase());
    return labels.some((l) => BONUS_P31.some((b) => l.includes(b))) ? 3 : 0;
  };
  for (const c of withBlurb) {
    c.score =
      c.dep.sitelinks * 3 + 4 + c.ii.width / 800 +
      (c.year < 1950 ? 4 : c.year < 2000 ? 1 : 0) + depBonus(c);
  }
  withBlurb.sort((a, b) => b.score - a.score);
  const perDep = new Map();
  const perYear = new Map();
  const perDec = new Map();
  const picked = [];
  const tryPick = (c, caps) => {
    if ((perDep.get(c.dep.qid) ?? 0) >= 2) return false;
    if ((perYear.get(c.year) ?? 0) >= 12) return false;
    if (caps) {
      const dec = Math.floor(c.year / 10) * 10;
      const cap = dec >= 2020 ? 50 : dec >= 2010 ? 70 : Infinity;
      if ((perDec.get(dec) ?? 0) >= cap) return false;
    }
    perDep.set(c.dep.qid, (perDep.get(c.dep.qid) ?? 0) + 1);
    perYear.set(c.year, (perYear.get(c.year) ?? 0) + 1);
    perDec.set(Math.floor(c.year / 10) * 10, (perDec.get(Math.floor(c.year / 10) * 10) ?? 0) + 1);
    picked.push(c);
    return true;
  };
  for (const c of withBlurb) {
    if (picked.length >= LIMIT) break;
    tryPick(c, true);
  }
  for (const c of withBlurb) {
    if (picked.length >= LIMIT) break;
    if (!picked.includes(c)) tryPick(c, false);
  }
  console.log(`picked: ${picked.length}`);

  const items = picked.map((c, i) => ({
    id: `ph-${c.dep.qid.slice(1)}-${c.year}-${i}`,
    title: c.dep.label,
    image: String(c.ii.thumb).split("?")[0], // strip utm tracking params
    page: c.ii.page,
    lat: Math.round(c.dep.lat * 1000) / 1000,
    lon: Math.round(c.dep.lon * 1000) / 1000,
    placeName: c.dep.label,
    year: c.year,
    license: c.ii.license,
    photographer: c.ii.artist || undefined,
    blurb: c.blurb,
    blurbSource: c.blurbSource,
  }));

  // Review gallery.
  const rows = picked
    .map((c, i) => {
      const it = items[i];
      return `<div class="card"><img loading="lazy" src="${it.image}" alt=""/><div class="meta">` +
        `<b>#${i} ${esc(it.title)}</b> · ${esc(c.dep.qid)} · ${c.year}<br>` +
        `${esc(it.placeName)} (${it.lat}, ${it.lon}) · score ${c.score.toFixed(1)} · ${c.dep.sitelinks} sitelinks<br>` +
        `<i>${esc(it.license)}</i> · ${esc(it.photographer ?? "?")}<br>` +
        `<p>${esc(it.blurb)}</p>` +
        `<a href="${it.page}">file</a> · <a href="${it.blurbSource}">blurb-src</a>` +
        `</div></div>`;
    })
    .join("\n");
  fs.writeFileSync(
    path.join(CACHE, "review.html"),
    `<!doctype html><html><head><meta charset="utf8"><title>snapshot review (${picked.length})</title>` +
      `<style>body{font-family:sans-serif;background:#111;color:#eee}.card{display:flex;gap:12px;margin:12px;padding:12px;background:#222;border-radius:8px}img{width:320px;object-fit:contain;background:#000}.meta{font-size:14px;max-width:640px}a{color:#8cf}</style></head>` +
      `<body><h1>snapshot review (${picked.length})</h1>${rows}</body></html>`,
  );
  console.log(`review: ${path.join(CACHE, "review.html")}`);
  cacheSet("pool.json", picked.map((c, i) => ({ ...c, ii: undefined, item: items[i] })));

  if (EMIT) {
    if (picked.length < LIMIT) {
      console.log(`WARNING: only ${picked.length}/${LIMIT} — emitting anyway`);
    }
    const ts =
      `import type { SnapshotItem } from "./types.js";\n\n` +
      `export const SNAPSHOT_ITEMS: SnapshotItem[] = ${JSON.stringify(items, null, 2)};\n`;
    fs.writeFileSync(OUT_TS, ts);
    console.log(`emitted ${items.length} items -> ${OUT_TS}`);
  } else {
    console.log("dry run: pass --emit to write items.ts");
  }
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
