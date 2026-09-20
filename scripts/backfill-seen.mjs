#!/usr/bin/env node
/** Backfill provenance (article, date kind/claims, subject types) for
 *  legacy tinder_seen rows, then delete WD rows still lacking requirements.
 *  Votes are preserved: only metadata columns are upgraded.
 *  Usage: node scripts/backfill-seen.mjs [dbPath]
 */
import { DatabaseSync } from "node:sqlite";

const dbPath = process.argv[2] ?? process.env["DB_PATH"] ?? "./data/leaderboard.db";
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 20000;");

const { preferredDateClaim } = await import("../dist-server/server/sources/wikidata/map.js");

const DATE_PROPS = ["P571", "P580", "P585", "P577"];
const rows = db.prepare(
  `SELECT event_qid FROM tinder_seen
   WHERE event_qid LIKE 'wd:%' AND (article = '' OR date_kind = '' OR date_claims = '')`,
).all();
console.log(`legacy rows: ${rows.length}`);

const UA = "DodocoHelper-tinder/1.0 (backfill-seen)";
let updated = 0;
for (let i = 0; i < rows.length; i += 50) {
  const ids = rows.slice(i, i + 50).map((r) => r.event_qid.replace(/^wd:/, "")).join("|");
  const url =
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids}` +
    `&props=claims|sitelinks&format=json&origin=*`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    console.log(`batch failed: HTTP ${res.status}, skipping`);
    continue;
  }
  const body = await res.json();
  for (const r of rows.slice(i, i + 50)) {
    const q = r.event_qid.replace(/^wd:/, "");
    const e = body.entities?.[q];
    if (!e) continue;
    const article = e.sitelinks?.enwiki?.title?.trim() || "";
    const claims = [];
    for (const p of DATE_PROPS) {
      for (const c of e.claims?.[p] ?? []) {
        const v = c.mainsnak?.datavalue?.value;
        if (typeof v?.time === "string" && typeof v?.precision === "number") {
          claims.push({ property: p, time: v.time, precision: v.precision });
        }
      }
    }
    const win = preferredDateClaim(claims.slice(0, 20));
    const types = [];
    for (const c of e.claims?.["P31"] ?? []) {
      const id = c.mainsnak?.datavalue?.value?.id;
      if (typeof id === "string" && /^Q\d+$/.test(id) && !types.includes(id)) types.push(id);
      if (types.length >= 5) break;
    }
    db.prepare(
      `UPDATE tinder_seen SET article = ?, date_kind = ?, date_precision = ?,
         date_claims = ?, subject_types = ?,
         year = COALESCE(NULLIF(?, 0), year),
         decade = CASE WHEN ? != 0 THEN CAST(? / 10 AS INTEGER) * 10 ELSE decade END
       WHERE event_qid = ?`,
    ).run(
      article, win?.property ?? "", win?.precision ?? 0,
      JSON.stringify(claims.slice(0, 20)), JSON.stringify(types),
      win?.year ?? 0, win?.year ?? 0, win?.year ?? 0, r.event_qid,
    );
    updated++;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(`backfilled: ${updated}`);

const del = db.prepare(
  `DELETE FROM tinder_seen
   WHERE event_qid LIKE 'wd:%' AND (article = '' OR date_kind = '' OR date_claims = '')`,
).run();
console.log(`deleted still-lacking: ${del.changes}`);
const q = (sql) => db.prepare(sql).get().n;
console.log(`seen total: ${q("SELECT COUNT(*) n FROM tinder_seen")}, accepted: ${q("SELECT COUNT(*) n FROM tinder_seen WHERE status='accepted'")}`);
db.close();
