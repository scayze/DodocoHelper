import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  GAME_RULES,
  dayKeyUTC,
  winScoreFor,
  type LeaderboardEntry,
  type LeaderboardGameId,
} from "../src/leaderboard/types.js";
import type { ValidSubmit } from "./validate.js";
import { DECADE_BUCKETS } from "./sources/types.js";

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scores(
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,
  game TEXT NOT NULL,
  display_name TEXT NOT NULL,
  client_id TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  moves INTEGER NOT NULL DEFAULT 0,
  hints_used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(day, game, client_id)
);
CREATE INDEX IF NOT EXISTS idx_board ON scores(day, game, duration_ms, moves, created_at);
CREATE TABLE IF NOT EXISTS tinder_seen(
  event_qid TEXT NOT NULL,
  image TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  place_name TEXT NOT NULL DEFAULT '',
  lat REAL NOT NULL DEFAULT 0,
  lon REAL NOT NULL DEFAULT 0,
  year INTEGER NOT NULL DEFAULT 0,
  decade INTEGER NOT NULL DEFAULT 0,
  point_in_time TEXT NOT NULL DEFAULT '',
  page TEXT NOT NULL DEFAULT '',
  thumb TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT '',
  blurb TEXT NOT NULL DEFAULT '',
  blurb_source TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  date_kind TEXT NOT NULL DEFAULT '',
  date_precision INTEGER NOT NULL DEFAULT 0,
  article TEXT NOT NULL DEFAULT '',
  file_usage TEXT NOT NULL DEFAULT '',
  subject_types TEXT NOT NULL DEFAULT '',
  date_claims TEXT NOT NULL DEFAULT '',
  translated INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT,
  UNIQUE(event_qid, image)
);
CREATE INDEX IF NOT EXISTS idx_tinder_status ON tinder_seen(status);
CREATE INDEX IF NOT EXISTS idx_tinder_decade ON tinder_seen(decade);
CREATE TABLE IF NOT EXISTS tinder_pool(
  qid TEXT NOT NULL,
  image TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  desc_lang TEXT,
  year INTEGER NOT NULL DEFAULT 0,
  lat REAL NOT NULL DEFAULT 0,
  lon REAL NOT NULL DEFAULT 0,
  page TEXT NOT NULL DEFAULT '',
  thumb TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT '',
  blurb_source TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  date_kind TEXT NOT NULL DEFAULT '',
  date_precision INTEGER NOT NULL DEFAULT 0,
  article TEXT NOT NULL DEFAULT '',
  file_usage TEXT NOT NULL DEFAULT '',
  subject_types TEXT NOT NULL DEFAULT '',
  date_claims TEXT NOT NULL DEFAULT '',
  served_at TEXT NOT NULL DEFAULT '',
  bucket INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(qid, image)
);
CREATE INDEX IF NOT EXISTS idx_tinder_pool_bucket ON tinder_pool(bucket, created_at);
CREATE TABLE IF NOT EXISTS wd_candidates(
  qid TEXT PRIMARY KEY,
  year INTEGER NOT NULL DEFAULT 0,
  lat REAL NOT NULL DEFAULT 0,
  lon REAL NOT NULL DEFAULT 0,
  bucket INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'new',
  fail_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_wd_candidates_state ON wd_candidates(state, bucket);
-- Slice-cursor machinery was replaced by gap-driven bulk discovery; drop residue.
DROP TABLE IF EXISTS wd_slices;
CREATE TABLE IF NOT EXISTS wd_stats(
  day TEXT PRIMARY KEY,
  sparql_count INTEGER NOT NULL DEFAULT 0,
  sparql_errors INTEGER NOT NULL DEFAULT 0,
  sparql_ms_total INTEGER NOT NULL DEFAULT 0
);
`;

interface ScoreRow {
  id: number;
  day: string;
  game: string;
  display_name: string;
  client_id: string;
  duration_ms: number;
  moves: number;
  hints_used: number;
  score: number | null;
  won: number | null;
  created_at: string;
  updated_at: string;
}

function toEntry(row: ScoreRow): LeaderboardEntry {
  const game = row.game as LeaderboardEntry["game"];
  return {
    id: row.id,
    day: row.day,
    game,
    displayName: row.display_name,
    clientId: row.client_id,
    durationMs: row.duration_ms,
    moves: row.moves,
    hintsUsed: row.hints_used,
    // Pre-score rows predate the columns (or carry the migration default):
    // surface the win-equivalent so old entries rank as wins.
    score: typeof row.score === "number" ? row.score : winScoreFor(game),
    won: row.won === null || row.won === undefined ? true : row.won === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ensureScoreColumns(db: Db): void {
  const cols = db
    .prepare("PRAGMA table_info(scores)")
    .all() as unknown as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("score")) db.exec("ALTER TABLE scores ADD COLUMN score INTEGER NOT NULL DEFAULT 0;");
  if (!names.has("won")) db.exec("ALTER TABLE scores ADD COLUMN won INTEGER NOT NULL DEFAULT 1;");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_board_score ON scores(day, game, score, duration_ms, moves, created_at);",
  );
  // Rows written before score/won existed get the migration defaults
  // (score 0, won 1): rank them as wins. New code never inserts
  // minesweeper won=1/score=0 (validation requires won === (score===100)),
  // so this backfill is idempotent and can't touch genuine 0% losses
  // (those carry won=0).
  db.exec("UPDATE scores SET won = 1 WHERE won IS NULL;");
  db.exec("UPDATE scores SET score = 100 WHERE game = 'minesweeper' AND won = 1 AND score = 0;");
}

export function openDb(path: string): Db {
  // SQLite creates the file but not its parent folders; the default
  // DB_PATH (./data/leaderboard.db) ships with no ./data dir checked in.
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  ensurePoolBlurbSource(db);
  ensureSourceColumns(db);
  ensurePoolServedAt(db);
  migratePendingToPool(db);
  ensureScoreColumns(db);
  return db;
}

/**
 * One-shot daily submit: one row per (day, game, clientId). A second submit
 * for the same triple is rejected as a duplicate and leaves the stored row
 * untouched. (Daily challenge: no retries; endless practice mode is separate
 * and never posts here.)
 */
export function submitScore(
  db: Db,
  input: ValidSubmit,
  now: Date = new Date(),
): { entry: LeaderboardEntry; duplicate: boolean } {
  const day = dayKeyUTC(now);
  const existing = db
    .prepare("SELECT * FROM scores WHERE day = ? AND game = ? AND client_id = ?")
    .get(day, input.game, input.clientId) as unknown as ScoreRow | undefined;

  if (existing) {
    return { entry: toEntry(existing), duplicate: true };
  }

  const created = now.toISOString();
  const result = db
    .prepare(
      `INSERT INTO scores(day, game, display_name, client_id, duration_ms, moves, hints_used, score, won, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      day,
      input.game,
      input.displayName,
      input.clientId,
      input.durationMs,
      input.moves,
      input.hintsUsed,
      input.score,
      input.won ? 1 : 0,
      created,
      created,
    );
  const row = db
    .prepare("SELECT * FROM scores WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as unknown as ScoreRow;
  return { entry: toEntry(row), duplicate: false };
}

export function getLeaderboard(
  db: Db,
  game: string,
  day: string,
  limit: number,
): LeaderboardEntry[] {
  // Primary metric first (time is only the tiebreak): per-game rank order
  // is driven by GAME_RULES — blocks-left ASC, percent-cleared DESC, and
  // time-only boards rank on duration alone.
  // `game` is validated as a LeaderboardGameId by the caller (app.ts).
  const metric = GAME_RULES[game as LeaderboardGameId].metric;
  const order = metric === "lowerScore"
    ? "score ASC, duration_ms ASC, moves ASC, created_at ASC"
    : metric === "higherScore"
      ? "score DESC, duration_ms ASC, moves ASC, created_at ASC"
      : "duration_ms ASC, moves ASC, created_at ASC";
  const rows = db
    .prepare(
      `SELECT * FROM scores WHERE day = ? AND game = ?
       ORDER BY ${order} LIMIT ?`,
    )
    .all(day, game, limit) as unknown as ScoreRow[];
  return rows.map(toEntry);
}

/** Canonical source key for a qid. */
export function sourceForQid(qid: string): string {
  if (qid.startsWith("wd:")) return "wikidata";
  if (qid.startsWith("hp:")) return "historypin";
  return "";
}

const SOURCE_COLUMNS = ["source", "date_kind", "date_precision", "article", "file_usage", "subject_types", "date_claims"] as const;

function tableColumns(db: Db, table: string): Set<string> {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as Array<{ name: string }>;
  return new Set(cols.map((c) => c.name));
}

/** Backfill for pre-existing databases: add provenance columns and derive
 *  `source` from the qid namespace. New tables already carry the columns. */
function ensureSourceColumns(db: Db): void {
  for (const table of ["tinder_pool", "tinder_seen"] as const) {
    const cols = tableColumns(db, table);
    const idCol = table === "tinder_pool" ? "qid" : "event_qid";
    for (const col of SOURCE_COLUMNS) {
      if (cols.has(col)) continue;
      const decl = col === "date_precision" ? "INTEGER NOT NULL DEFAULT 0" : "TEXT NOT NULL DEFAULT ''";
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl};`);
    }
    db.prepare(
      `UPDATE ${table} SET source = CASE
         WHEN ${idCol} LIKE 'wd:%' THEN 'wikidata'
         WHEN ${idCol} LIKE 'hp:%' THEN 'historypin'
         ELSE '' END
       WHERE source = ''`,
    ).run();
  }
}

/** Images already decided (accepted/rejected). There is no pending state:
 *  votes assemble decided rows directly from served pool rows, so undecided
 *  cards stay servable (reload-safe) and only decided ones are excluded. */
export function tinderExcludeKeys(db: Db): Set<string> {
  const rows = db.prepare(
    `SELECT image FROM tinder_seen WHERE status <> 'pending'`,
  ).all() as unknown as Array<{ image: string }>;
  return new Set(rows.map((r) => r.image));
}

/** Decided event ids (same rows as above, qid namespace). Historypin
 *  dedupes by pin id; Wikidata by image (one item, many files). */
export function tinderExcludedQids(db: Db): Set<string> {
  const rows = db.prepare(
    `SELECT event_qid FROM tinder_seen WHERE status <> 'pending'`,
  ).all() as unknown as Array<{ event_qid: string }>;
  return new Set(rows.map((r) => r.event_qid));
}

/** Flag pool rows as served (votable). Serving itself is a pure read;
 *  this flag is the only write, and it carries no quarantine semantics. */
export function tinderMarkServed(db: Db, images: string[]): void {
  if (images.length === 0) return;
  const placeholders = images.map(() => "?").join(",");
  db.prepare(
    `UPDATE tinder_pool SET served_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE image IN (${placeholders}) AND served_at = ''`,
  ).run(...images);
}

export interface TinderPoolRow {
  qid: string; image: string; title: string; label: string;
  description: string; descLang: string | null; year: number;
  lat: number; lon: number; page: string; thumb: string; license: string;
  blurbSource?: string | null;
  source?: string | null;
  dateKind?: string | null;
  datePrecision?: number | null;
  article?: string | null;
  fileUsage?: string | null;
  subjectTypes?: string | null;
  dateClaims?: string | null;
}

function ensurePoolBlurbSource(db: Db): void {
  const cols = db
    .prepare("PRAGMA table_info(tinder_pool)")
    .all() as unknown as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "blurb_source")) {
    db.exec("ALTER TABLE tinder_pool ADD COLUMN blurb_source TEXT NOT NULL DEFAULT '';");
  }
}

function ensurePoolServedAt(db: Db): void {
  const cols = tableColumns(db, "tinder_pool");
  if (!cols.has("served_at")) {
    db.exec("ALTER TABLE tinder_pool ADD COLUMN served_at TEXT NOT NULL DEFAULT '';");
  }
}

/** One-time retirement of the pending state: resurrect served-but-undecided
 *  rows back into the pool (they carry full metadata), then delete them.
 *  Post-migration every seen row is decided; votes assemble decided rows
 *  from served pool rows instead. */
function migratePendingToPool(db: Db): void {
  db.prepare(
    `INSERT OR IGNORE INTO tinder_pool(qid, image, title, label, description, desc_lang, year, lat, lon, page, thumb, license, blurb_source, source, date_kind, date_precision, article, file_usage, subject_types, date_claims, bucket, served_at)
     SELECT event_qid, image, title, title, blurb,
            CASE translated WHEN 1 THEN 'en' ELSE NULL END,
            year, lat, lon, page, thumb, license, blurb_source, source, date_kind, date_precision, article, file_usage, subject_types, date_claims, decade,
            strftime('%Y-%m-%dT%H:%M:%fZ','now')
     FROM tinder_seen WHERE status = 'pending'`,
  ).run();
  db.prepare(`DELETE FROM tinder_seen WHERE status = 'pending'`).run();
}

export function tinderPoolInsert(db: Db, rows: TinderPoolRow[]): number {
  ensurePoolBlurbSource(db);
  ensureSourceColumns(db);
  ensurePoolServedAt(db);
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO tinder_pool(qid, image, title, label, description, desc_lang, year, lat, lon, page, thumb, license, blurb_source, source, date_kind, date_precision, article, file_usage, subject_types, date_claims, bucket)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  for (const r of rows) {
    const res = stmt.run(r.qid, r.image, r.title, r.label, r.description, r.descLang, r.year,
      r.lat, r.lon, r.page, r.thumb, r.license, r.blurbSource ?? "",
      r.source || sourceForQid(r.qid), r.dateKind ?? "", r.datePrecision ?? 0,
      r.article ?? "", r.fileUsage ?? "", r.subjectTypes ?? "", r.dateClaims ?? "",
      Math.floor(r.year / 10) * 10);
    n += Number(res.changes);
  }
  return n;
}

export type TinderSourceFilter = "hp" | "wd";

function sourceClause(source: TinderSourceFilter | null): string {
  if (source === "hp") return ` AND source = 'historypin'`;
  if (source === "wd") return ` AND source = 'wikidata'`;
  return "";
}

export function tinderPoolTakeRange(db: Db, from: number, to: number, limit: number, source: TinderSourceFilter | null = null): TinderPoolRow[] {
  const rows = db.prepare(
    `SELECT qid, image, title, label, description, desc_lang AS descLang, year, lat, lon, page, thumb, license,
            blurb_source AS blurbSource, source, date_kind AS dateKind,
            date_precision AS datePrecision, article, file_usage AS fileUsage,
            subject_types AS subjectTypes, date_claims AS dateClaims
     FROM tinder_pool WHERE year >= ? AND year < ?${sourceClause(source)} ORDER BY created_at ASC LIMIT ?`,
  ).all(from, to, limit * 3) as unknown as TinderPoolRow[];
  // Prefer distinct events within one serving so cards vary.
  const seenQid = new Set<string>();
  const first: TinderPoolRow[] = [];
  const rest: TinderPoolRow[] = [];
  for (const r of rows) {
    if (seenQid.has(r.qid)) rest.push(r);
    else {
      seenQid.add(r.qid);
      first.push(r);
    }
  }
  return [...first, ...rest].slice(0, limit);
}

export function tinderPoolRemove(db: Db, images: string[]): void {
  if (images.length === 0) return;
  const placeholders = images.map(() => "?").join(",");
  db.prepare(`DELETE FROM tinder_pool WHERE image IN (${placeholders})`).run(...images);
}

export interface TinderVoteInput {
  eventQid: string;
  image: string;
  /** URL that actually rendered client-side (display or fallback). */
  rendered: string;
  decision: "accepted" | "rejected";
}

/** First vote wins. The decided row is assembled from the served pool row
 *  (single source of truth — the vote POST carries only ids), the pool row
 *  is retired, and the rendered URL is kept as thumb so the dataset holds a
 *  known-good image. Votes for unserved/unknown cards or re-votes return
 *  false. Undecided cards stay in the pool and remain servable. */
export function tinderVote(db: Db, input: TinderVoteInput): boolean {
  const pool = db.prepare(
    `SELECT qid, image, title, description, year, lat, lon, page, thumb, license,
            blurb_source AS blurbSource, source, date_kind AS dateKind,
            date_precision AS datePrecision, article, file_usage AS fileUsage,
            subject_types AS subjectTypes, date_claims AS dateClaims, served_at AS servedAt
     FROM tinder_pool WHERE qid = ? AND image = ?`,
  ).get(input.eventQid, input.image) as unknown as {
    qid: string; image: string; title: string; description: string; year: number;
    lat: number; lon: number; page: string; thumb: string; license: string;
    blurbSource: string; source: string; dateKind: string; datePrecision: number;
    article: string; fileUsage: string; subjectTypes: string; dateClaims: string;
    servedAt: string;
  } | undefined;
  if (!pool || !pool.servedAt) return false;
  const rendered = input.rendered.startsWith("http") ? input.rendered.slice(0, 500) : pool.image;
  const res = db.prepare(
    `INSERT OR IGNORE INTO tinder_seen(event_qid, image, title, place_name, lat, lon, year, decade, point_in_time, page, thumb, license, blurb, blurb_source, source, date_kind, date_precision, article, file_usage, subject_types, date_claims, translated, status, decided_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  ).run(
    pool.qid, pool.image, pool.title, pool.title, pool.lat, pool.lon, pool.year,
    Math.floor(pool.year / 10) * 10, String(pool.year), pool.page, rendered,
    pool.license, pool.description, pool.blurbSource || pool.page,
    pool.source || sourceForQid(pool.qid), pool.dateKind ?? "", pool.datePrecision ?? 0,
    pool.article ?? "", pool.fileUsage ?? "", pool.subjectTypes ?? "", pool.dateClaims ?? "",
    input.decision,
  );
  if (Number(res.changes) === 0) return false;
  db.prepare(`DELETE FROM tinder_pool WHERE qid = ? AND image = ?`).run(pool.qid, pool.image);
  return true;
}

export function tinderCounts(db: Db): { pending: number; accepted: number; rejected: number } {
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM tinder_seen GROUP BY status`)
    .all() as unknown as Array<{ status: string; n: number }>;
  const out = { pending: 0, accepted: 0, rejected: 0 };
  for (const r of rows) {
    if (r.status === "pending") out.pending = r.n;
    else if (r.status === "accepted") out.accepted = r.n;
    else if (r.status === "rejected") out.rejected = r.n;
  }
  return out;
}

/** Total pool depth (pool-size guard for the background worker). */
export function poolTotal(db: Db): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM tinder_pool`).get() as unknown as { n: number };
  return row.n;
}

export function tinderExport(db: Db, decision: "accepted" | "rejected" = "accepted"): Array<Record<string, unknown>> {
  const rows = db.prepare(
    `SELECT event_qid, image AS thumb_img, title, place_name, lat, lon, year, page, thumb, license, blurb, blurb_source,
            source, date_kind AS dateKind, date_precision AS datePrecision, article, file_usage AS fileUsage,
            subject_types AS subjectTypes, date_claims AS dateClaims, decided_at, created_at
     FROM tinder_seen WHERE status = ? ORDER BY COALESCE(decided_at, created_at) ASC`,
  ).all(decision) as unknown as Array<{
    event_qid: string; thumb_img: string; title: string; place_name: string;
    lat: number; lon: number; year: number; page: string; thumb: string;
    license: string; blurb: string; blurb_source: string;
    source: string; dateKind: string; datePrecision: number; article: string; fileUsage: string;
    subjectTypes: string; dateClaims: string;
    decided_at: string | null; created_at: string | null;
  }>;
  return rows.map((r) => ({
    id: exportIdForSource(r.event_qid, r.year),
    source: r.source || sourceForQid(r.event_qid),
    dateKind: r.dateKind || null,
    datePrecision: r.datePrecision || null,
    article: r.article || null,
    fileUsage: parseFileUsage(r.fileUsage),
    subjectTypes: parseSubjectTypes(r.subjectTypes),
    dateClaims: parseDateClaims(r.dateClaims),
    title: r.title,
    image: r.thumb || r.thumb_img,
    page: r.page,
    lat: r.lat,
    lon: r.lon,
    placeName: r.place_name,
    year: r.year,
    license: r.license,
    blurb: r.blurb,
    blurbSource: r.blurb_source,
    // Snapshot-eligibility day = acceptance day (decided_at), falling back
    // to created_at for legacy rows. Daily D only picks addedDay < D, so
    // accepts today never shift today's puzzle. Both columns are UTC
    // `YYYY-MM-DDTHH:MM:...Z`; the date prefix is the UTC calendar day.
    addedDay: ((r.decided_at ?? r.created_at ?? "").slice(0, 10) || undefined) as string | undefined,
  }));
}

/** Parse a stored file_usage blob into an array (null when none). */
export function parseFileUsage(raw: string | null | undefined): Array<{ wiki: string; title: string; url: string }> | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v) || v.length === 0) return null;
    const out: Array<{ wiki: string; title: string; url: string }> = [];
    for (const e of v) {
      if (typeof e !== "object" || e === null) continue;
      const o = e as Record<string, unknown>;
      if (typeof o["wiki"] === "string" && typeof o["title"] === "string" && typeof o["url"] === "string") {
        out.push({ wiki: o["wiki"], title: o["title"], url: o["url"] });
      }
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Parse a stored subject_types blob into QIDs ([] when none). */
export function parseSubjectTypes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((e): e is string => typeof e === "string" && /^Q\d+$/.test(e));
  } catch {
    return [];
  }
}

export interface StoredDateClaim {
  property: string;
  time: string;
  precision: number;
}

/** Parse a stored date_claims blob ([] when none). */
export function parseDateClaims(raw: string | null | undefined): StoredDateClaim[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: StoredDateClaim[] = [];
    for (const e of v) {
      if (typeof e !== "object" || e === null) continue;
      const o = e as Record<string, unknown>;
      if (typeof o["property"] === "string" && typeof o["time"] === "string" && typeof o["precision"] === "number") {
        out.push({ property: o["property"], time: o["time"], precision: o["precision"] });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Stable Snapshot export id, routed by source namespace (`hp:` →
 *  `hp-…`, `wd:Q…` → `wd-Q…-…`). Kept here (instead of importing the
 *  adapter registry) to avoid a runtime import cycle: adapters import
 *  this module for pool helpers. Rules must match
 *  `server/sources/*` adapters. */
export function exportIdForSource(eventQid: string, year: number): string {
  if (/^hp:\d+$/.test(eventQid)) return `hp-${eventQid.replace(/^hp:/, "")}-${year}`;
  if (/^wd:Q\d+$/.test(eventQid)) return `wd-${eventQid.replace(/^wd:/, "")}-${year}`;
  const clean = eventQid.replace(/^(hp:|wd:)/, "").replace(/[^A-Za-z0-9]+/g, "");
  return `src-${clean || "x"}-${year}`;
}

/** Per-source pool depth for `/api/tinder/stats` (additive, optional). */
export function tinderPoolBySource(db: Db): { historypin: number; wikidata: number } {
  const rows = db
    .prepare(`SELECT source, qid FROM tinder_pool`)
    .all() as unknown as Array<{ source: string; qid: string }>;
  let historypin = 0;
  let wikidata = 0;
  for (const r of rows) {
    const s = r.source || sourceForQid(r.qid);
    if (s === "wikidata") wikidata++;
    else historypin++;
  }
  return { historypin, wikidata };
}

/** Pool counts per DECADE_BUCKETS index (optional source filter).
 *  Drives gap-driven bulk discovery and scarcity-weighted serving. */
export function poolDecadeHistogram(db: Db, source: TinderSourceFilter | null = null): number[] {
  const rows = db
    .prepare(`SELECT year FROM tinder_pool WHERE 1 = 1${sourceClause(source)}`)
    .all() as unknown as Array<{ year: number }>;
  return DECADE_BUCKETS.map((b, i) => {
    const to = i + 1 < DECADE_BUCKETS.length ? DECADE_BUCKETS[i + 1]!.from : 2026;
    let n = 0;
    for (const r of rows) {
      if (r.year >= b.from && r.year < to) n++;
    }
    return n;
  });
}

