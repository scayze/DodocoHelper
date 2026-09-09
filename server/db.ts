import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dayKeyUTC, type LeaderboardEntry } from "../src/leaderboard/types.js";
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
  created_at: string;
  updated_at: string;
}

function toEntry(row: ScoreRow): LeaderboardEntry {
  return {
    id: row.id,
    day: row.day,
    game: row.game as LeaderboardEntry["game"],
    displayName: row.display_name,
    clientId: row.client_id,
    durationMs: row.duration_ms,
    moves: row.moves,
    hintsUsed: row.hints_used,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
  return db;
}

/**
 * Daily best-time upsert: one row per (day, game, clientId); only a faster
 * time replaces the stored row. Returns the stored row + whether it improved.
 */
export function submitScore(
  db: Db,
  input: ValidSubmit,
  now: Date = new Date(),
): { entry: LeaderboardEntry; improved: boolean } {
  const day = dayKeyUTC(now);
  const existing = db
    .prepare("SELECT * FROM scores WHERE day = ? AND game = ? AND client_id = ?")
    .get(day, input.game, input.clientId) as unknown as ScoreRow | undefined;

  if (!existing) {
    const created = now.toISOString();
    const result = db
      .prepare(
        `INSERT INTO scores(day, game, display_name, client_id, duration_ms, moves, hints_used, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        day,
        input.game,
        input.displayName,
        input.clientId,
        input.durationMs,
        input.moves,
        input.hintsUsed,
        created,
        created,
      );
    const row = db
      .prepare("SELECT * FROM scores WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as unknown as ScoreRow;
    return { entry: toEntry(row), improved: true };
  }

  if (input.durationMs < existing.duration_ms) {
    db.prepare(
      `UPDATE scores SET display_name = ?, duration_ms = ?, moves = ?,
        hints_used = ?, updated_at = ? WHERE id = ?`,
    ).run(
      input.displayName,
      input.durationMs,
      input.moves,
      input.hintsUsed,
      now.toISOString(),
      existing.id,
    );
    const row = db
      .prepare("SELECT * FROM scores WHERE id = ?")
      .get(existing.id) as unknown as ScoreRow;
    return { entry: toEntry(row), improved: true };
  }

  // Slower (or equal) time: keep the best, but refresh the display name so a
  // rename still takes effect without losing the best time.
  if (existing.display_name !== input.displayName) {
    db.prepare("UPDATE scores SET display_name = ? WHERE id = ?").run(
      input.displayName,
      existing.id,
    );
    const row = db
      .prepare("SELECT * FROM scores WHERE id = ?")
      .get(existing.id) as unknown as ScoreRow;
    return { entry: toEntry(row), improved: false };
  }
  return { entry: toEntry(existing), improved: false };
}

export function getLeaderboard(
  db: Db,
  game: string,
  day: string,
  limit: number,
): LeaderboardEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM scores WHERE day = ? AND game = ?
       ORDER BY duration_ms ASC, moves ASC, created_at ASC LIMIT ?`,
    )
    .all(day, game, limit) as unknown as ScoreRow[];
  return rows.map(toEntry);
}
