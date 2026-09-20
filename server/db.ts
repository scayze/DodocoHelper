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
  bucket INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(qid, image)
);
CREATE INDEX IF NOT EXISTS idx_tinder_pool_bucket ON tinder_pool(bucket, created_at);
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

export interface TinderSeenInput {
  /** Vote/dedupe namespace key: Historypin `hp:<id>`. */
  eventQid: string;
  image: string;
  title: string;
  placeName: string;
  lat: number;
  lon: number;
  year: number;
  pointInTime: string;
  page: string;
  thumb: string;
  license: string;
  blurb: string;
  blurbSource: string;
}

export function tinderSeenKeys(db: Db, images: string[]): Set<string> {
  if (images.length === 0) return new Set();
  const placeholders = images.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT image FROM tinder_seen WHERE image IN (${placeholders})`)
    .all(...images) as unknown as Array<{ image: string }>;
  return new Set(rows.map((r) => r.image));
}

export function tinderMarkSeen(db: Db, cards: TinderSeenInput[]): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO tinder_seen(event_qid, image, title, place_name, lat, lon, year, decade, point_in_time, page, thumb, license, blurb, blurb_source, translated, status)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending')`,
  );
  for (const c of cards) {
    stmt.run(
      c.eventQid, c.image, c.title, c.placeName, c.lat, c.lon, c.year,
      Math.floor(c.year / 10) * 10, c.pointInTime, c.page, c.thumb,
      c.license, c.blurb, c.blurbSource,
    );
  }
}

/** Images to exclude from serving: everything decided, plus pendings
 *  served recently (abandoned queues older than 2h become servable again
 *  so the pool never shrinks from unvoted serves). */
export function tinderExcludeKeys(db: Db): Set<string> {
  const rows = db.prepare(
    `SELECT image FROM tinder_seen
     WHERE status IN ('accepted','rejected')
        OR (status = 'pending' AND created_at > datetime('now','-2 hours'))`,
  ).all() as unknown as Array<{ image: string }>;
  return new Set(rows.map((r) => r.image));
}

export interface TinderPoolRow {
  qid: string; image: string; title: string; label: string;
  description: string; descLang: string | null; year: number;
  lat: number; lon: number; page: string; thumb: string; license: string;
}

export function tinderPoolInsert(db: Db, rows: TinderPoolRow[]): number {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO tinder_pool(qid, image, title, label, description, desc_lang, year, lat, lon, page, thumb, license, bucket)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  for (const r of rows) {
    const res = stmt.run(r.qid, r.image, r.title, r.label, r.description, r.descLang, r.year,
      r.lat, r.lon, r.page, r.thumb, r.license, Math.floor(r.year / 10) * 10);
    n += Number(res.changes);
  }
  return n;
}

export function tinderPoolCountRange(db: Db, from: number, to: number): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM tinder_pool WHERE year >= ? AND year < ?`)
    .get(from, to) as unknown as { n: number };
  return row.n;
}

export function tinderPoolTakeRange(db: Db, from: number, to: number, limit: number): TinderPoolRow[] {
  const rows = db.prepare(
    `SELECT qid, image, title, label, description, desc_lang AS descLang, year, lat, lon, page, thumb, license
     FROM tinder_pool WHERE year >= ? AND year < ? ORDER BY created_at ASC LIMIT ?`,
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

/** Remember the URL that actually rendered in the voter's browser: export
 *  prefers thumb, so the dataset keeps a known-good image URL. */
export function tinderNoteRendered(db: Db, eventQid: string, image: string, rendered: string): void {
  db.prepare(
    `UPDATE tinder_seen SET thumb = ?
     WHERE event_qid = ? AND (image = ? OR thumb = ?)`,
  ).run(rendered.slice(0, 500), eventQid, image, image);
}

export function tinderVote(
  db: Db,
  eventQid: string,
  image: string,
  decision: "accepted" | "rejected",
): boolean {
  const result = db
    .prepare(
      `UPDATE tinder_seen SET status = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE event_qid = ? AND (image = ? OR thumb = ?) AND status = 'pending'`,
    )
    .run(decision, eventQid, image, image);
  return Number(result.changes) > 0;
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

export function tinderSeenByDecade(db: Db): number[] {
  const rows = db
    .prepare(`SELECT decade, COUNT(*) AS n FROM tinder_seen GROUP BY decade`)
    .all() as unknown as Array<{ decade: number; n: number }>;
  // Align with DECADE_BUCKETS order in server/tinder.ts (duplicated here
  // to keep db.ts free of tinder.ts imports).
  const buckets = [1700, 1800, 1850, 1900, 1920, 1940, 1960, 1980, 2000];
  return buckets.map((from, i) => {
    const to = i + 1 < buckets.length ? buckets[i + 1]! : 2026;
    let n = 0;
    for (const r of rows) {
      if (r.decade >= from && r.decade < to) n += r.n;
      else if (from === 1700 && r.decade < 1800 && r.decade >= 1400) n += r.n;
    }
    return n;
  });
}

export function tinderExport(db: Db, decision: "accepted" | "rejected" = "accepted"): Array<Record<string, unknown>> {
  const rows = db.prepare(
    `SELECT event_qid, image AS thumb_img, title, place_name, lat, lon, year, page, thumb, license, blurb, blurb_source,
            decided_at, created_at
     FROM tinder_seen WHERE status = ? ORDER BY COALESCE(decided_at, created_at) ASC`,
  ).all(decision) as unknown as Array<{
    event_qid: string; thumb_img: string; title: string; place_name: string;
    lat: number; lon: number; year: number; page: string; thumb: string;
    license: string; blurb: string; blurb_source: string;
    decided_at: string | null; created_at: string | null;
  }>;
  return rows.map((r) => ({
    id: `hp-${r.event_qid.replace(/^hp:/, "")}-${r.year}`,
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

