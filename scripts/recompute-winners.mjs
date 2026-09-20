#!/usr/bin/env node
/** Recompute game years from stored claim sets under the current preference
 *  order (P585 > P580 > P577 > P571). Upgrades rows decided/enriched under
 *  the old earliest-wins rule without re-harvesting anything.
 *  Usage: node scripts/recompute-winners.mjs [dbPath]
 */
import { DatabaseSync } from "node:sqlite";

const dbPath = process.argv[2] ?? process.env["DB_PATH"] ?? "./data/leaderboard.db";
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 20000;");

const { preferredDateClaim } = await import("../dist-server/server/sources/wikidata/map.js");

let poolN = 0;
for (const r of db.prepare(
  `SELECT qid, image, year, date_kind, date_claims FROM tinder_pool WHERE qid LIKE 'wd:%'`,
).all()) {
  let claims = [];
  try { claims = JSON.parse(r.date_claims || "[]"); } catch { continue; }
  const win = preferredDateClaim(claims);
  if (!win || (win.year === r.year && win.property === r.date_kind)) continue;
  db.prepare(
    `UPDATE tinder_pool SET year = ?, date_kind = ?, date_precision = ?,
       bucket = CAST(CAST(? AS INTEGER) / 10 AS INTEGER) * 10
     WHERE qid = ? AND image = ?`,
  ).run(win.year, win.property, win.precision, win.year, r.qid, r.image);
  poolN++;
}
let seenN = 0;
for (const r of db.prepare(
  `SELECT event_qid, image, year, date_kind, date_claims FROM tinder_seen WHERE event_qid LIKE 'wd:%'`,
).all()) {
  let claims = [];
  try { claims = JSON.parse(r.date_claims || "[]"); } catch { continue; }
  const win = preferredDateClaim(claims);
  if (!win || (win.year === r.year && win.property === r.date_kind)) continue;
  db.prepare(
    `UPDATE tinder_seen SET year = ?, date_kind = ?, date_precision = ?,
       decade = CAST(CAST(? AS INTEGER) / 10 AS INTEGER) * 10
     WHERE event_qid = ? AND image = ?`,
  ).run(win.year, win.property, win.precision, win.year, r.event_qid, r.image);
  seenN++;
}
console.log(`winners recomputed: pool=${poolN} seen=${seenN}`);
db.close();
