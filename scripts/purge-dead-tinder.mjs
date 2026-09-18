#!/usr/bin/env node
// One-off cleanup: drop tinder rows whose image URL is dead or empty on the
// Historypin CDN (404, or 200 with a sub-photo body). Pool rows and *pending*
// seen rows are deleted (pending pins become re-harvestable; the harvester
// now skips them if still broken). Decided rows are only REPORTED —
// accepted/rejected votes are never rewritten here.
//
// Usage: node scripts/purge-dead-tinder.mjs [--db ./data/leaderboard.db]
import { openDb, tinderPoolRemove } from "../dist-server/server/db.js";
import { imageUsable } from "../dist-server/server/tinder.js";

const args = process.argv.slice(2);
const dbFlag = args.indexOf("--db");
const dbPath = dbFlag >= 0 && args[dbFlag + 1] ? args[dbFlag + 1] : "./data/leaderboard.db";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = openDb(dbPath);

async function check(label, images) {
  const bad = [];
  let i = 0;
  for (const image of images) {
    i++;
    let ok = false;
    try {
      ok = await imageUsable(image);
    } catch {
      ok = false;
    }
    if (!ok) bad.push(image);
    if (i % 5 === 0) console.log(`  ${label}: checked ${i}/${images.length}...`);
    await sleep(2000); // gentle: bursts poison the CDN edge cache
  }
  return bad;
}

const pool = db.prepare("SELECT image FROM tinder_pool").all().map((r) => r.image);
console.log(`pool: ${pool.length} rows`);
const badPool = await check("pool", pool);
if (badPool.length > 0) tinderPoolRemove(db, badPool);
console.log(`pool: removed ${badPool.length}`);

const pending = db.prepare("SELECT image FROM tinder_seen WHERE status = 'pending'").all().map((r) => r.image);
console.log(`pending: ${pending.length} rows`);
const badPending = await check("pending", pending);
if (badPending.length > 0) {
  const stmt = db.prepare("DELETE FROM tinder_seen WHERE image = ? AND status = 'pending'");
  for (const image of badPending) stmt.run(image);
}
console.log(`pending: removed ${badPending.length}`);

for (const status of ["accepted", "rejected"]) {
  const rows = db.prepare("SELECT event_qid, image FROM tinder_seen WHERE status = ?").all(status);
  const bad = await check(status, rows.map((r) => r.image));
  const badQids = new Set(bad);
  console.log(`${status}: ${bad.length} broken (kept, votes untouched):`);
  for (const r of rows) {
    if (badQids.has(r.image)) console.log(`  ${r.event_qid} ${r.image}`);
  }
}

db.close();
console.log("done.");
