/** Wikidata discovery: gap-driven bulk ID harvesting.
 *
 * Cost strategy: QLever answers our analytic shape (multi-predicate join +
 * range filter + ORDER BY + LIMIT) in ~1s, so a few large queries replace
 * hundreds of small ones. SPARQL returns minimal rows only
 * (QID + year + coords); labels, descriptions, images and blurbs come
 * later via batched Action/Commons APIs. Discovery runs only when the
 * enrichment queue runs low; all serving-side sampling happens in SQLite.
 *
 * Hardfilter: items must have an English Wikipedia article (sitelink).
 * This doubles as a quality filter — articles correlate with curated
 * images, complete dates/coords, and a guaranteed blurb source.
 */
import type { Db } from "../../db.js";
import {
  API_POLITE as _api,
  SPARQL_POLITE,
  noteSparqlCall,
  politeGetJson,
  sparqlBudgetExhausted,
  UpstreamBusyError,
} from "./polite.js";

void _api;

export interface WdCandidate {
  qid: string;
  year: number;
  lat: number;
  lon: number;
}

export function ensureCandidateTables(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS wd_candidates(
       qid TEXT PRIMARY KEY,
       year INTEGER NOT NULL DEFAULT 0,
       lat REAL NOT NULL DEFAULT 0,
       lon REAL NOT NULL DEFAULT 0,
       bucket INTEGER NOT NULL DEFAULT 0,
       state TEXT NOT NULL DEFAULT 'new',
       fail_count INTEGER NOT NULL DEFAULT 0,
       updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     );
     CREATE INDEX IF NOT EXISTS idx_wd_candidates_state ON wd_candidates(state, bucket);`,
  );
}

/** QLever is primary for discovery: it answers our analytic shape in ~1s,
 *  while WDQS times out on the same query. WDQS stays as fallback.
 *  QLever needs explicit PREFIXes (WDQS predefines them; harmless there). */
export function sparqlEndpoint(): string {
  return process.env["WD_SPARQL_ENDPOINT"] ?? "https://qlever.dev/api/wikidata";
}

export function sparqlFallback(): string | null {
  if (process.env["WD_QLEVER_FALLBACK"] === "0") return null;
  return process.env["WD_SPARQL_FALLBACK"] ?? "https://query.wikidata.org/sparql";
}

export const SPARQL_PREFIXES =
  "PREFIX wd: <http://www.wikidata.org/entity/> " +
  "PREFIX wdt: <http://www.wikidata.org/prop/direct/> " +
  "PREFIX xsd: <http://www.w3.org/2001/XMLSchema#> " +
  "PREFIX schema: <http://schema.org/> ";

/** Date properties queried per range. Deliberately event-only: inception
 *  dates (P571) make poor game years (building-birth ≠ photo-date), and
 *  publication dates (P577) barely exist under our filters (~5 per 20yr
 *  range). Point-in-time and start dates are the depicted moment.
 *  Enrichment still reads all properties from claims (preference order
 *  decides the winner); this list only gates discovery. */
export const DISCOVERY_DATE_PROPS = ["P585", "P580"];

/** Bulk range query: single date property + direct datetime range filter
 *  (index-friendly — YEAR() would force a full scan) + required enwiki
 *  sitelink. No labels, no RAND, no OFFSET. */
export function buildBulkQuery(
  y0: number,
  y1: number,
  prop: string,
  limit: number,
): string {
  const pad = (y: number): string => `${y}-01-01T00:00:00Z`;
  return `${SPARQL_PREFIXES}SELECT ?item ?coord ?date WHERE {
  ?item wdt:P18 ?img;
        wdt:P625 ?coord;
        wdt:${prop} ?date.
  ?article schema:about ?item;
           schema:isPartOf <https://en.wikipedia.org/>.
  FILTER(?date >= "${pad(y0)}"^^xsd:dateTime && ?date < "${pad(y1)}"^^xsd:dateTime)
} ORDER BY ?item LIMIT ${limit}`;
}

interface SparqlJson {
  results?: {
    bindings?: Array<{
      item?: { value?: string };
      coord?: { value?: string };
      date?: { value?: string };
    }>;
  };
}

/** `Point(lon lat)` → { lat, lon }. Case-insensitive: QLever returns
 *  `POINT(...)`, WDQS returns `Point(...)`. */
export function parseWktPoint(wkt: string): { lat: number; lon: number } | null {
  const m = /^Point\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i.exec(wkt.trim());
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000 };
}

export function yearFromXsdDateTime(v: string): number | null {
  const m = /^(\d{4})-/.exec(v);
  if (!m) return null;
  const y = Number(m[1]);
  return Number.isInteger(y) && y >= 1400 && y <= 2026 ? y : null;
}

function qidFromIri(iri: string): string | null {
  const m = /^https?:\/\/www\.wikidata\.org\/entity\/(Q\d+)$/.exec(iri.trim());
  return m ? `wd:${m[1]}` : null;
}

/** Pure SPARQL-JSON → candidates (unit-testable, no I/O). */
export function parseSliceRows(body: SparqlJson): WdCandidate[] {
  const out: WdCandidate[] = [];
  const seen = new Set<string>();
  for (const b of body.results?.bindings ?? []) {
    const qid = b.item?.value ? qidFromIri(b.item.value) : null;
    const pt = b.coord?.value ? parseWktPoint(b.coord.value) : null;
    const year = b.date?.value ? yearFromXsdDateTime(b.date.value) : null;
    if (!qid || !pt || year === null || seen.has(qid)) continue;
    seen.add(qid);
    out.push({ qid, year, ...pt });
  }
  return out;
}

export function insertCandidates(db: Db, rows: WdCandidate[]): number {
  if (rows.length === 0) return 0;
  ensureCandidateTables(db);
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO wd_candidates(qid, year, lat, lon, bucket)
     VALUES(?, ?, ?, ?, ?)`,
  );
  let n = 0;
  for (const r of rows) {
    const res = stmt.run(r.qid, r.year, r.lat, r.lon, Math.floor(r.year / 10) * 10);
    n += Number(res.changes);
  }
  return n;
}

export function discoveryLogTables(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS wd_discover_log(
       range_key TEXT PRIMARY KEY,
       inserted INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     );`,
  );
}

/** True when this range was bulk-discovered within the last `days` days.
 *  Re-querying only replays known QIDs (INSERT OR IGNORE), so repeats are
 *  pure upstream waste until fresh data arrives. */
export function rangeRecentlyDiscovered(db: Db, rangeKey: string, days = 7): boolean {
  discoveryLogTables(db);
  const row = db
    .prepare(`SELECT created_at FROM wd_discover_log WHERE range_key = ?`)
    .get(rangeKey) as unknown as { created_at: string } | undefined;
  if (!row) return false;
  const ageMs = Date.now() - Date.parse(row.created_at);
  return Number.isFinite(ageMs) && ageMs < days * 24 * 3600 * 1000;
}

export function noteDiscovery(db: Db, rangeKey: string, inserted: number): void {
  discoveryLogTables(db);
  db.prepare(
    `INSERT INTO wd_discover_log(range_key, inserted) VALUES(?, ?)
     ON CONFLICT(range_key) DO UPDATE SET inserted = excluded.inserted,
       created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(rangeKey, inserted);
}

export function countNewCandidates(db: Db): number {
  ensureCandidateTables(db);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM wd_candidates WHERE state = 'new' AND fail_count < 3`)
    .get() as unknown as { n: number };
  return row.n;
}

async function runBulkQuery(query: string): Promise<SparqlJson | null> {
  const endpoints = [sparqlEndpoint(), sparqlFallback()].filter(
    (e): e is string => typeof e === "string" && e.length > 0,
  );
  for (const ep of endpoints) {
    try {
      const url = `${ep}?query=${encodeURIComponent(query)}&format=json`;
      return await politeGetJson<SparqlJson>(url, { ...SPARQL_POLITE, channel: "wdqs" });
    } catch (e) {
      if (e instanceof UpstreamBusyError) break;
      // try next endpoint
    }
  }
  return null;
}

/** Bulk discovery for a year range: one large query per date property.
 *  Returns candidates inserted. Never throws for routine upstream trouble.
 *  Respects the daily SPARQL budget (checked once per call). */
export async function discoverBulk(
  db: Db,
  y0: number,
  y1: number,
  limitPerProp = 1500,
): Promise<number> {
  ensureCandidateTables(db);
  const budget = Number(process.env["WD_DAILY_SPARQL_BUDGET"] ?? "200");
  if (sparqlBudgetExhausted(db, Number.isFinite(budget) ? budget : 200)) return 0;
  let total = 0;
  for (const prop of DISCOVERY_DATE_PROPS) {
    const started = Date.now();
    let body: SparqlJson | null = null;
    try {
      body = await runBulkQuery(buildBulkQuery(y0, y1, prop, limitPerProp));
    } catch {
      body = null;
    }
    noteSparqlCall(db, Date.now() - started, body !== null);
    if (!body) continue;
    total += insertCandidates(db, parseSliceRows(body));
  }
  return total;
}
