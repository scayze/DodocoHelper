/** Wikidata source adapter.
 *
 * Implements `SourceAdapter` over the `wd:` namespace. Live fetches happen
 * only in the background worker (`worker.ts`); the request-path
 * `harvestStep` only enqueues a worker kick and returns 0, so user traffic
 * can never stampede WDQS.
 */
import type { Db } from "../../db.js";
import { buildBaseCard, type DecadeBucket, type SourceAdapter, type SourceCard, type TinderCard } from "../types.js";
import { kickWikidataWorker } from "./worker.js";

export function isWikidataId(v: string): boolean {
  return /^wd:Q\d+$/.test(v);
}

export const wikidataAdapter: SourceAdapter = {
  key: "wikidata",
  isSourceId: isWikidataId,
  nextQuery(): string | null {
    return null; // slice selection lives in the worker
  },
  async harvestStep(db: Db, _bucket: DecadeBucket, _query: string | null): Promise<number> {
    void _bucket;
    void _query;
    // Never fetch inline: the pool is filled by the background worker.
    kickWikidataWorker(db);
    return 0;
  },
  toCard(row: SourceCard): TinderCard {
    // Commons URLs are stable: no Historypin-style URL rewriting.
    return buildBaseCard(row);
  },
  exportId(eventQid: string, year: number): string {
    return `wd-${eventQid.replace(/^wd:/, "")}-${year}`;
  },
};
