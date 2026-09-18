/** Tinder curator: lazy Historypin harvest (no bulk ingest, no API key).
 *
 * Runtime flow per GET /api/tinder/next:
 *   1. pick an underrepresented decade bucket (+ rotating keyword)
 *   2. one small /pins/ list fetch (12 cards, random page of the filtered
 *      total) + detail fetches for the top unseen cards — paced, sequential
 *   3. drop rows already in tinder_seen, insert the rest into tinder_pool
 *   4. serve from the pool, least-curated decades first
 *
 * Same SnapshotItem schema as the game; separate dataset (tinder_seen table).
 * Historypin blurbs are English upstream, so there is no translation step.
 *
 * NOTE: the documented Historypin v7 API (/en/api/...) is retired (404).
 * This harvester scrapes the live site's server-rendered pages instead:
 *   - GET /pins/?primary_media_type=image&start_date=..&end_date=..
 *         &search_query=..&pins_page=N   (list, 12 cards + total count)
 *   - GET /pins/<id>/                    (title, description, date, lat/lon,
 *                                         full-size image, license)
 */

export interface TinderCard {
  id: string;
  title: string;
  image: string;
  /** Second-chance URL when image fails at display time (null = none). */
  fallbackImage: string | null;
  page: string;
  lat: number;
  lon: number;
  placeName: string;
  year: number;
  license: string;
  blurb: string;
  blurbSource: string;
  /** Historypin pin id, `hp:<digits>`. Stable vote/dedupe namespace. */
  pinId: string;
  /** Full-size image URL: stable vote/dedupe key (image is the display URL). */
  sourceImage: string;
}

import type { Db } from "./db.js";
import { tinderExcludeKeys, tinderPoolInsert } from "./db.js";

export interface DecadeBucket {
  from: number;
  to: number;
}

export function bucketIndex(bucket: DecadeBucket): number {
  return DECADE_BUCKETS.indexOf(bucket);
}

export const DECADE_BUCKETS: DecadeBucket[] = [
  { from: 1700, to: 1800 },
  { from: 1800, to: 1850 },
  { from: 1850, to: 1900 },
  { from: 1900, to: 1920 },
  { from: 1920, to: 1940 },
  { from: 1940, to: 1960 },
  { from: 1960, to: 1980 },
  { from: 1980, to: 2000 },
  { from: 2000, to: 2026 },
];

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

export function pickBucket(seenByBucket: number[]): { bucket: DecadeBucket; index: number } {
  const order = pickBucketOrder(seenByBucket);
  const first = order[0]!;
  const index = DECADE_BUCKETS.indexOf(first.bucket);
  return { bucket: first.bucket, index };
}

/** All buckets, least-seen first (random tie-break). */
export function pickBucketOrder(seenByBucket: number[]): Array<{ bucket: DecadeBucket }> {
  const idx = DECADE_BUCKETS.map((_, i) => i);
  idx.sort((a, b) => (seenByBucket[a] ?? 0) - (seenByBucket[b] ?? 0) + (Math.random() - 0.5));
  return idx.map((i) => ({ bucket: DECADE_BUCKETS[i]! }));
}

export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = t;
  }
  return arr;
}

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

export function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

export interface CardInput {
  pinId: string;
  title: string;
  /** Display image (full-size pin image). */
  image: string;
  /** Embedded original: display fallback. */
  fallbackImage?: string | null;
  /** Stable vote/dedupe key (same as image). */
  sourceImage: string;
  year: number;
  lat: number;
  lon: number;
  page: string;
  license: string;
  blurb: string;
}

export function toCard(row: CardInput): TinderCard {
  // Full text to the client: the UI collapses it with an expand toggle,
  // and the DB/export keeps the whole blurb (no mid-sentence cuts).
  // Display URLs get the fresh cache key (bypasses poisoned CDN objects);
  // sourceImage stays raw so votes match the stored dedupe key.
  return {
    id: `${row.pinId}-${row.year}-${shortHash(row.sourceImage)}`,
    title: row.title,
    image: freshUrl(row.image),
    page: row.page,
    lat: row.lat,
    lon: row.lon,
    placeName: row.title,
    year: row.year,
    license: row.license,
    blurb: row.blurb.trim() || row.title,
    blurbSource: row.page,
    pinId: row.pinId,
    sourceImage: row.sourceImage,
    fallbackImage: row.fallbackImage ? freshUrl(row.fallbackImage) : null,
  };
}

/** One harvest step: list search (random page of the filtered total) ->
 *  detail fetches for the top unseen cards -> pool. Returns rows inserted.
 *  Paced; a step costs ~1 list + ≤6 detail fetches. */
export async function harvestHistorypinStep(
  db: Db,
  bucket: DecadeBucket,
  query: string | null,
  detailsPerStep = 8,
): Promise<number> {
  const first = await historypinSearch({ from: bucket.from, to: bucket.to, query, page: 1 });
  const totalPages = Math.max(1, Math.min(4000, Math.ceil(first.total / 12)));
  const page = totalPages <= 1 ? 1 : 1 + Math.floor(Math.random() * totalPages);
  const list = page === 1 ? first : await historypinSearch({
    from: bucket.from, to: bucket.to, query, page,
  });
  const excluded = tinderExcludeKeys(db);
  const fresh = shuffle(
    list.cards.filter((c) => !excluded.has(`hp:${c.pinId}`)),
  ).slice(0, detailsPerStep);
  // Three concurrent detail workers: detail pages are independent GETs
  // (browsers do 6+); list fetches stay strictly sequential + paced.
  const rows: Array<{
    qid: string; image: string; title: string; label: string;
    description: string; descLang: string | null; year: number;
    lat: number; lon: number; page: string; thumb: string; license: string;
  }> = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < fresh.length) {
      const c = fresh[cursor++]!;
      const d = await historypinPinDetail(c.pinId);
      if (!d || d.year === null) continue;
      if (LICENSE_BLOCK.test(d.license)) continue;
      const key = `hp:${d.pinId}`;
      if (excluded.has(key)) continue;
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
      });
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  if (rows.length === 0) return 0;
  return tinderPoolInsert(db, rows);
}
