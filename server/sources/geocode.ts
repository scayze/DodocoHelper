/** Server-side reverse-geocoding via BigDataCloud.
 *
 * Answers only: curated rows get city-down-to-continent labels once at
 * accept/backfill time. Guesses are never sent anywhere.
 *
 * Uses the keyless `reverse-geocode-client` endpoint by default (same one
 * verified against live traffic); if BIGDATACLOUD_API_KEY is set, the
 * keyed endpoint is used instead for higher quotas. Volumes here are tiny
 * (47-row backfill + one call per accept), politely spaced.
 */
import {
  emptyGeoFields,
  tinderPoolNeedingGeo,
  tinderPoolUpdateGeo,
  tinderSeenNeedingGeo,
  tinderUpdateGeo,
  type Db,
  type GeoFields,
} from "../db.js";

export type { GeoFields };

const GEO_UA = "DodocoHelper-tinder/1.0 (reverse-geocode backfill)";
const GEO_TIMEOUT_MS = 15000;
/** Min spacing between upstream calls (free quota is per-minute paced). */
const GEO_SPACING_MS = 1100;
const MAX_FIELD_LEN = 120;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function clean(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, MAX_FIELD_LEN);
}

/** API key from env ('' = keyless endpoint with fair-use limits). */
export function geoApiKey(): string {
  return (process.env["BIGDATACLOUD_API_KEY"] ?? "").trim();
}

/** Reverse-geocode one coordinate pair. Never throws ('' fields on failure).
 *  apiKey may be '' for the keyless endpoint. */
export async function fetchGeoFields(lat: number, lon: number, apiKey = ""): Promise<GeoFields> {
  const empty = emptyGeoFields();
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return empty;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEO_TIMEOUT_MS);
  try {
    const base = apiKey
      ? `https://api.bigdatacloud.net/data/reverse-geocode?latitude=${lat}&longitude=${lon}` +
        `&localityLanguage=en&key=${encodeURIComponent(apiKey)}`
      : `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}` +
        `&localityLanguage=en`;
    const res = await fetch(base, { headers: { "User-Agent": GEO_UA }, signal: ctrl.signal });
    if (!res.ok) return empty;
    const body = (await res.json()) as Record<string, unknown>;
    return {
      city: clean(body["city"]),
      locality: clean(body["locality"]),
      subdivision: clean(body["principalSubdivision"]),
      countryName: clean(body["countryName"]),
      countryCode: clean(body["countryCode"]),
      continent: clean(body["continent"]),
    };
  } catch {
    return empty;
  } finally {
    clearTimeout(timer);
  }
}

/** Periodic trickle: keep unenriched rows (pool + decided) labeled as new
 *  harvests land. Small batches, politely spaced; overlapping ticks skip. */
export function scheduleGeoWorker(db: Db, intervalMs: number, batchSize = 30): void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await enrichPendingGeo(db, { limit: batchSize });
    } catch {
      // Best-effort: next tick retries.
    } finally {
      running = false;
    }
  };
  setInterval(() => void tick(), Math.max(60_000, intervalMs));
}

/** Enrich a single decided row (fire-and-forget safe). */
export async function enrichGeoRow(db: Db, qid: string, image: string, apiKey = ""): Promise<boolean> {
  if (!qid || !image) return false;
  const row = db.prepare(
    `SELECT lat, lon FROM tinder_seen WHERE event_qid = ? AND image = ?`,
  ).get(qid, image) as unknown as { lat: number; lon: number } | undefined;
  if (!row) return false;
  const geo = await fetchGeoFields(row.lat, row.lon, apiKey);
  if (!geo.countryName && !geo.city && !geo.locality) return false;
  return tinderUpdateGeo(db, qid, image, geo);
}

/** Backfill loop: oldest unenriched rows first (decided, then pool),
 *  politely spaced. Limit applies per table. Returns { done, failed }. */
export async function enrichPendingGeo(
  db: Db,
  opts: { apiKey?: string; limit?: number; spacingMs?: number; log?: (msg: string) => void } = {},
): Promise<{ done: number; failed: number }> {
  const apiKey = opts.apiKey ?? geoApiKey();
  const log = opts.log ?? (() => {});
  const spacing = Number.isFinite(opts.spacingMs) ? Math.max(0, opts.spacingMs!) : GEO_SPACING_MS;
  const limit = opts.limit ?? 500;
  const seen = tinderSeenNeedingGeo(db, limit).map((r) => ({
    table: "seen" as const, qid: r.eventQid, image: r.image, lat: r.lat, lon: r.lon,
  }));
  const pool = tinderPoolNeedingGeo(db, limit).map((r) => ({
    table: "pool" as const, qid: r.qid, image: r.image, lat: r.lat, lon: r.lon,
  }));
  const rows = [...seen, ...pool];
  log(`geo: ${rows.length} rows need labels (seen=${seen.length} pool=${pool.length})`);
  let done = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (i > 0) await sleep(spacing);
    try {
      const geo = await fetchGeoFields(r.lat, r.lon, apiKey);
      if (!geo.countryName && !geo.city && !geo.locality) {
        failed++;
        continue;
      }
      const ok = r.table === "seen"
        ? tinderUpdateGeo(db, r.qid, r.image, geo)
        : tinderPoolUpdateGeo(db, r.qid, r.image, geo);
      if (ok) done++;
      else failed++;
    } catch {
      failed++;
    }
    if ((i + 1) % 25 === 0) log(`geo: ${i + 1}/${rows.length} (done=${done} failed=${failed})`);
  }
  log(`geo: finished done=${done} failed=${failed}`);
  return { done, failed };
}
