/** Shapes solution counter: partitions of the 16 cards into valid quads.
 *
 * Solution identity is order-free: neither the order of the groups nor the
 * order of cards within a group matters. Counting stops at `cap` (default 2)
 * since generation only needs to distinguish 0 / 1 / many.
 */

import { ROW_SIZE } from "./types.js";
import { isValidSet } from "./logic.js";
import type { Card } from "./types.js";

/** All index-quads (into `cards`) that form a valid set. */
export function findValidQuads(cards: readonly Card[]): number[][] {
  const n = cards.length;
  const out: number[][] = [];
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (let c = b + 1; c < n; c++) {
        for (let d = c + 1; d < n; d++) {
          if (isValidSet([cards[a]!, cards[b]!, cards[c]!, cards[d]!])) {
            out.push([a, b, c, d]);
          }
        }
      }
    }
  }
  return out;
}

/**
 * Count exact covers of `cards` by valid quads, up to `cap`. Requires
 * `cards.length` to be a multiple of 4 (16 for a real board); anything else
 * yields 0.
 */
export function countSolutions(cards: readonly Card[], cap = 2): number {
  if (cards.length === 0 || cards.length % ROW_SIZE !== 0) return 0;
  const quads = findValidQuads(cards);
  // Index: quads containing each card, so the search branches only on
  // covers of the first uncovered card (canonical, no permutation dupes).
  const byCard: number[][] = cards.map(() => []);
  quads.forEach((q, qi) => {
    for (const idx of q) byCard[idx]!.push(qi);
  });
  const used = new Array<boolean>(cards.length).fill(false);
  let count = 0;

  function firstFree(): number {
    for (let i = 0; i < used.length; i++) if (!used[i]) return i;
    return -1;
  }

  function search(): void {
    if (count >= cap) return;
    const first = firstFree();
    if (first === -1) {
      count++;
      return;
    }
    for (const qi of byCard[first]!) {
      const q = quads[qi]!;
      if (q.some((idx) => used[idx])) continue;
      for (const idx of q) used[idx] = true;
      search();
      for (const idx of q) used[idx] = false;
      if (count >= cap) return;
    }
  }

  search();
  return count;
}
