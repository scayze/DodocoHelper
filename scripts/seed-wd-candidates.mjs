#!/usr/bin/env node
/** Seed `wd_candidates` from a prebuilt JSON list (offline SPARQL/dump output).
 *
 * Usage: node scripts/seed-wd-candidates.mjs candidates.json [dbPath]
 * Input: [{ "qid": "wd:Q243", "year": 1889, "lat": 48.85, "lon": 2.35 }, …]
 * (`wd:` prefix optional; added when missing.)
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const file = process.argv[2];
if (!file) {
  console.error("usage: seed-wd-candidates.mjs candidates.json [dbPath]");
  process.exit(1);
}
const dbPath = process.argv[3] ?? process.env["DB_PATH"] ?? "./data/leaderboard.db";
const raw = JSON.parse(readFileSync(file, "utf8"));
const rows = Array.isArray(raw) ? raw : raw.candidates ?? [];
const db = new DatabaseSync(dbPath);
db.exec(
  `CREATE TABLE IF NOT EXISTS wd_candidates(
     qid TEXT PRIMARY KEY, year INTEGER NOT NULL DEFAULT 0,
     lat REAL NOT NULL DEFAULT 0, lon REAL NOT NULL DEFAULT 0,
     bucket INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'new',
     fail_count INTEGER NOT NULL DEFAULT 0,
     updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );`,
);
const stmt = db.prepare(
  `INSERT OR IGNORE INTO wd_candidates(qid, year, lat, lon, bucket) VALUES(?, ?, ?, ?, ?)`,
);
let n = 0;
for (const r of rows) {
  const q = String(r.qid ?? r.id ?? "");
  const qid = q.startsWith("wd:") ? q : `wd:${q}`;
  if (!/^wd:Q\d+$/.test(qid)) continue;
  const year = Number(r.year);
  if (!Number.isInteger(year)) continue;
  const res = stmt.run(qid, year, Number(r.lat) || 0, Number(r.lon) || 0, Math.floor(year / 10) * 10);
  n += Number(res.changes);
}
console.log(`seeded ${n} candidates into ${dbPath}`);
db.close();
