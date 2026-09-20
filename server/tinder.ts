/** Tinder curator core: source-neutral serving helpers.
 *
 * Source-specific harvest lives in `server/sources/` behind the
 * `SourceAdapter` seam (`server/sources/types.ts`). This module keeps the
 * generic pieces — decade buckets, serving order, card id hashing — plus
 * legacy re-exports so existing imports keep working.
 */
import type { Db } from "./db.js";
import {
  buildBaseCard,
  DECADE_BUCKETS,
  shortHash,
  shuffle,
  type DecadeBucket,
  type SourceAdapter,
  type SourceCard,
  type TinderCard,
} from "./sources/types.js";

export {
  buildBaseCard,
  DECADE_BUCKETS,
  shortHash,
  shuffle,
  type DecadeBucket,
  type SourceAdapter,
  type SourceCard,
  type TinderCard,
};

// Legacy Historypin re-exports (prefer `server/sources/historypin.js`).
export {
  CDN_FRESH,
  flippedSize,
  freshUrl,
  harvestHistorypinStep,
  historypinPinDetail,
  historypinSearch,
  HP_KEYWORDS,
  imageUsable,
  isPinId,
  nextKeyword,
  parsePinYear,
  type CardInput,
  type HpListCard,
  type HpPinDetail,
  type HpSearchResult,
} from "./sources/historypin.js";
import { toCard as hpToCard, type CardInput } from "./sources/historypin.js";

/** Generic card builder (no source URL rewriting). Historypin display
 *  URLs need the CDN fresh key, so the legacy `toCard` below keeps the
 *  Historypin behavior for compatibility. */
export function toCardBase(row: SourceCard): TinderCard {
  return buildBaseCard(row);
}

/** Legacy `toCard` (Historypin semantics incl. `freshUrl`). New adapters
 *  use their own `SourceAdapter.toCard`. */
export function toCard(row: CardInput): TinderCard {
  return hpToCard(row);
}

export function bucketIndex(bucket: DecadeBucket): number {
  return DECADE_BUCKETS.indexOf(bucket);
}

export function pickBucket(seenByBucket: number[]): { bucket: DecadeBucket; index: number } {
  const order = pickBucketOrder(seenByBucket);
  const first = order[0]!;
  const index = DECADE_BUCKETS.indexOf(first.bucket);
  return { bucket: first.bucket, index };
}

/** All buckets, least-seen first (random tie-break). */
export function pickBucketOrder(seenByBucket: number[]): Array<{ bucket: DecadeBucket }> {
  const idx = DECADE_BUCKETS.map((_, i) => i);
  idx.sort((a, b) => (seenByBucket[a] ?? 0) - (seenByBucket[b] ?? 0) + (Math.random() - 0.5));
  return idx.map((i) => ({ bucket: DECADE_BUCKETS[i]! }));
}

/** Type helper: Db re-export for adapter implementors importing via core. */
export type { Db };
