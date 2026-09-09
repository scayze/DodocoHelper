/** Framework-free Tents and Trees solver: existence + uniqueness counting. No DOM. */

import { ORTHO, orthoTrees, touchesPlaced } from "./logic.js";

interface TreeSlot {
  r: number;
  c: number;
  options: Array<[number, number]>;
}

function buildSlots(trees: boolean[][], size: number): TreeSlot[] | null {
  const slots: TreeSlot[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!trees[r][c]) continue;
      const options: Array<[number, number]> = [];
      for (const [dr, dc] of ORTHO) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
        if (trees[nr][nc]) continue; // tents can't sit on a tree
        // Trees are fixed, so a tent's tree-neighbor count is static:
        // only cells touching exactly one tree can ever hold a tent.
        if (orthoTrees(trees, size, nr, nc) !== 1) continue;
        options.push([nr, nc]);
      }
      if (options.length === 0) return null;
      slots.push({ r, c, options });
    }
  }
  // Fewest options first: prunes bad branches early.
  slots.sort((a, b) => a.options.length - b.options.length);
  return slots;
}

/**
 * Count solutions up to `cap`. Returns 0, 1, or cap (meaning "cap or more").
 * A solution assigns every tree a distinct, non-touching orthogonal tent
 * cell with exact row/column counts, where every tent touches exactly one
 * tree. The first solution found can be read back via `out`.
 */
export function countSolutions(
  trees: boolean[][],
  rowCounts: number[],
  colCounts: number[],
  cap = 2,
  out?: boolean[][],
  nodeLimit = 200_000,
): number {
  const size = trees.length;
  const maybeSlots = buildSlots(trees, size);
  if (!maybeSlots) return 0;
  const slots: TreeSlot[] = maybeSlots;
  if (slots.length !== rowCounts.reduce((a, b) => a + b, 0)) return 0;

  const placed: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  const rowUsed = Array(size).fill(0);
  const colUsed = Array(size).fill(0);
  let count = 0;
  let nodes = 0;
  const first: boolean[][] | null = out ?? null;

  function search(k: number): boolean {
    nodes++;
    if (nodes > nodeLimit) return true; // stop: treat as exhausted budget
    if (count >= cap) return true;
    if (k === slots.length) {
      // All counts exact by construction; verify the 1-to-1 pairing:
      // no tent may touch a second tree.
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (placed[r][c] && orthoTrees(trees, size, r, c) !== 1) return false;
        }
      }
      count++;
      if (first && count === 1) {
        for (let r = 0; r < size; r++) {
          for (let c = 0; c < size; c++) first[r][c] = placed[r][c];
        }
      }
      return count >= cap;
    }
    const slot = slots[k];
    for (const [r, c] of slot.options) {
      if (placed[r][c]) continue;
      if (rowUsed[r] >= rowCounts[r] || colUsed[c] >= colCounts[c]) continue;
      if (touchesPlaced(placed, size, r, c)) continue;
      // A tent claiming this cell must not already touch another tree.
      // (Its own tree always touches; a second one rules the cell out.)
      if (orthoTrees(trees, size, r, c) !== 1) continue;
      placed[r][c] = true;
      rowUsed[r]++;
      colUsed[c]++;
      const done = search(k + 1);
      placed[r][c] = false;
      rowUsed[r]--;
      colUsed[c]--;
      if (done) return true;
    }
    return false;
  }

  search(0);
  return count;
}

/** First solution, or null when unsolved / ambiguous is irrelevant (returns one). */
export function solveTents(
  trees: boolean[][],
  rowCounts: number[],
  colCounts: number[],
): boolean[][] | null {
  const size = trees.length;
  const out: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  return countSolutions(trees, rowCounts, colCounts, 1, out) === 1 ? out : null;
}
