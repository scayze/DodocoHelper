import { createServer } from "node:http";
import { createHandler } from "./app.js";
import { openDb } from "./db.js";
import { sourceMode } from "./sources/index.js";
import { scheduleHistorypinWorker } from "./sources/historypin.js";
import { scheduleWikidataWorker } from "./sources/wikidata/worker.js";
import { scheduleGeoWorker } from "./sources/geocode.js";

const port = Number(process.env["PORT"] ?? "3001");
const dbPath = process.env["DB_PATH"] ?? "./data/leaderboard.db";

const db = openDb(dbPath);
const server = createServer(createHandler(db));

// All harvesting runs out-of-band: the request path only ever reads the DB.
// Historypin trickles (small paced steps); Wikidata runs gap-driven bulk
// cycles. Each source's worker is enabled by SOURCE (default: mixed).
const mode = sourceMode();
if (mode !== "wikidata") {
  const intervalMs = Number(process.env["HP_CRON_MS"] ?? String(10 * 60 * 1000));
  scheduleHistorypinWorker(db, Number.isFinite(intervalMs) ? intervalMs : 10 * 60 * 1000);
  console.log(`historypin worker enabled (mode=${mode})`);
}
if (mode !== "historypin") {
  const intervalMs = Number(process.env["WD_CRON_MS"] ?? String(15 * 60 * 1000));
  scheduleWikidataWorker(db, Number.isFinite(intervalMs) ? intervalMs : 15 * 60 * 1000);
  console.log(`wikidata worker enabled (mode=${mode})`);
}
// Geo labels trickle over pool + decided rows (keyless fair use, small
// batches); backfill script covers the initial backlog.
{
  const intervalMs = Number(process.env["GEO_CRON_MS"] ?? String(10 * 60 * 1000));
  scheduleGeoWorker(db, Number.isFinite(intervalMs) ? intervalMs : 10 * 60 * 1000);
  console.log("geo worker enabled");
}

server.listen(port, () => {
  console.log(`leaderboard api listening on :${port} (db: ${dbPath})`);
});
