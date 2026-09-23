#!/usr/bin/env node
/** Backfill BigDataCloud reverse-geocode labels (city..continent) for
 *  all tinder rows (pool + decided). Only metadata columns are upgraded.
 *  Keyless by default; set BIGDATACLOUD_API_KEY for higher quotas.
 *  Usage: node scripts/backfill-geo.mjs [dbPath] [--limit=N]
 *  Requires: npm run build:server (imports from dist-server).
 */
const args = process.argv.slice(2);
const dbPath = args.find((a) => !a.startsWith("--")) ?? process.env["DB_PATH"] ?? "./data/leaderboard.db";
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : 500;

const { enrichPendingGeo } = await import("../dist-server/server/sources/geocode.js");
const { openDb } = await import("../dist-server/server/db.js");
// openDb runs migrations (adds geo columns to pre-existing DBs).
const db = openDb(dbPath);
db.exec("PRAGMA busy_timeout = 20000;");

const res = await enrichPendingGeo(db, {
  limit: Number.isFinite(limit) ? limit : 500,
  log: (m) => console.log(m),
});
console.log(`backfill-geo: done=${res.done} failed=${res.failed}`);
db.close();
