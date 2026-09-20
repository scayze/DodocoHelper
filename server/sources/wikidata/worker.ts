/** Wikidata background worker: gap-driven bulk cycles.
 *
 * The request path (`serveTinderNext`) never touches WDQS. This worker is
 * the only place that does. Each cycle:
 *   1. read the pool histogram, find the thinnest decade,
 *   2. bulk-discover it (a few large QLever queries) — but only when the
 *      enrichment queue runs low, so discovery stays rare and polite,
 *   3. enrich one batch of candidates into the pool.
 * Never throws; never blocks serving.
 */
import type { Db } from "../../db.js";
import { poolDecadeHistogram, poolTotal } from "../../db.js";
import { DECADE_BUCKETS } from "../types.js";
import {
  countNewCandidates, discoverBulk, ensureCandidateTables,
  noteDiscovery, rangeRecentlyDiscovered,
} from "./discovery.js";
import { enrichCandidates } from "./enrich.js";

export interface WdWorkerOptions {
  dailyBudget?: number;
  enrichBatch?: number;
  /** Bulk discovery limit per date property (default 1500). */
  discoverLimit?: number;
  /** Enrichment queue depth below which discovery runs (default 200). */
  discoverBelow?: number;
}

let queued: Promise<unknown> | null = null;

/** Thinnest pool decade (index into DECADE_BUCKETS), all sources. */
export function thinnestPoolDecade(db: Db): number {
  const hist = poolDecadeHistogram(db);
  let best = 0;
  for (let i = 1; i < hist.length; i++) {
    if ((hist[i] ?? 0) < (hist[best] ?? 0)) best = i;
  }
  return best;
}

/** Thinnest pool decade not bulk-discovered in the last `days` days
 *  (null when every range is fresh — discovery would only replay known
 *  QIDs, so the cycle should enrich-only). */
export function thinnestUndiscoveredDecade(db: Db, days = 7): number | null {
  const hist = poolDecadeHistogram(db);
  let best: number | null = null;
  for (let i = 0; i < hist.length; i++) {
    const b = DECADE_BUCKETS[i]!;
    if (rangeRecentlyDiscovered(db, `${b.from}-${b.to}`, days)) continue;
    if (best === null || (hist[i] ?? 0) < (hist[best] ?? 0)) best = i;
  }
  return best;
}

/** One cycle: gap-driven bulk discovery (when the queue is low) + one
 *  enrichment batch. Never throws. */
export async function runWikidataCycle(db: Db, opts: WdWorkerOptions = {}): Promise<{ discovered: number; inserted: number; dead: number }> {
  const out = { discovered: 0, inserted: 0, dead: 0 };
  try {
    ensureCandidateTables(db);
    if (opts.dailyBudget !== undefined) process.env["WD_DAILY_SPARQL_BUDGET"] = String(opts.dailyBudget);
    if (countNewCandidates(db) < (opts.discoverBelow ?? 200)) {
      const bi = thinnestUndiscoveredDecade(db);
      if (bi !== null) {
        const b = DECADE_BUCKETS[bi]!;
        const n = await discoverBulk(db, b.from, b.to, opts.discoverLimit ?? 1500);
        noteDiscovery(db, `${b.from}-${b.to}`, n);
        out.discovered += n;
      }
    }
    // Pool rows retire only on vote now: cap enrichment so an idle curator
    // can't grow the pool without bound (rows are tiny, this is just hygiene).
    if (poolTotal(db) > 5000) return out;
    const enrich = await enrichCandidates(db, opts.enrichBatch ?? 20);
    out.inserted += enrich.inserted;
    out.dead += enrich.dead;
  } catch {
    // Background worker must never crash the server.
  }
  return out;
}

/** Enqueue a cycle (coalesced: at most one pending). For pool-low signals. */
export function kickWikidataWorker(db: Db, opts: WdWorkerOptions = {}): void {
  if (queued) return;
  queued = runWikidataCycle(db, opts).finally(() => {
    queued = null;
  });
}

/** Interval timer for `server/index.ts`. Returns a stop function. */
export function scheduleWikidataWorker(db: Db, intervalMs: number, opts: WdWorkerOptions = {}): () => void {
  const ms = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 15 * 60 * 1000;
  const timer = setInterval(() => {
    kickWikidataWorker(db, opts);
  }, ms);
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  return () => clearInterval(timer);
}
