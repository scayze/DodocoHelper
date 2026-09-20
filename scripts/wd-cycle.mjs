#!/usr/bin/env node
/** One-off Wikidata harvest cycle (immediate, for initial pool fill).
 *  Usage: node scripts/wd-cycle.mjs [dbPath]
 *  Safe to run alongside the API (WAL + busy timeout).
 */
import { DatabaseSync } from "node:sqlite";

const dbPath = process.argv[2] ?? process.env["DB_PATH"] ?? "./data/leaderboard.db";
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 10000;");

const { runWikidataCycle } = await import("../dist-server/server/sources/wikidata/worker.js");
const started = Date.now();
const res = await runWikidataCycle(db, { enrichBatch: 40, discoverLimit: 1500 });
console.log(JSON.stringify({ ...res, ms: Date.now() - started }));
db.close();
