/** Shapes puzzle generator: sample a solution, shuffle it, keep unique boards.
 *
 * Construction (never rejection on raw cards):
 *  1. Build 4 disjoint valid quads directly: per feature flip a coin for
 *     all-same (random value) vs all-different (random permutation). This
 *     yields a valid quad by construction; retries only handle card
 *     collisions (duplicate cards within/across quads).
 *  2. Shuffle the 16 cards onto the grid (Fisher–Yates over `rand`); redraw
 *     while any row starts pre-solved so the puzzle is never dealt finished.
 *  3. Count exact-cover solutions (cap 2); accept only uniqueness.
 * Outer retries resample the solution. Deterministic in `rand`: the same
 * seed always deals the same board (daily play), `Math.random` for endless.
 */

import {
  CELL_COUNT,
  FEATURE_COUNT,
  ROW_COUNT,
  ROW_SIZE,
  VALUES_PER_FEATURE,
  cardKey,
  type Card,
} from "./types.js";
import { isValidSet } from "./logic.js";
import { countSolutions } from "./solver.js";

export interface ShapesPuzzle {
  /** The 16 distinct deal cards. */
  cards: Card[];
  /** Cell -> card index, row-major over the 4x4 grid. */
  pos: number[];
}

const MAX_SOLUTIONS_ATTEMPTS = 200;
const MAX_QUAD_ATTEMPTS = 50;
const MAX_SHUFFLE_ATTEMPTS = 50;

function randInt(rand: () => number, n: number): number {
  return Math.floor(rand() * n);
}

/** Random permutation of [0..n). */
function shuffledRange(rand: () => number, n: number): number[] {
  const out = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = randInt(rand, i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** One valid quad by construction: per feature, all-same or all-different. */
function buildQuad(rand: () => number): Card[] {
  const cols: number[][] = [];
  for (let f = 0; f < FEATURE_COUNT; f++) {
    if (rand() < 0.5) {
      const v = randInt(rand, VALUES_PER_FEATURE);
      cols.push([v, v, v, v]);
    } else {
      cols.push(shuffledRange(rand, VALUES_PER_FEATURE));
    }
  }
  return Array.from({ length: ROW_SIZE }, (_, i) => [
    cols[0]![i]!,
    cols[1]![i]!,
    cols[2]![i]!,
    cols[3]![i]!,
  ]) as Card[];
}

/** Sample 16 distinct cards forming 4 disjoint valid quads. */
function sampleSolutionCards(rand: () => number): Card[] {
  const cards: Card[] = [];
  const seen = new Set<string>();
  for (let q = 0; q < ROW_COUNT; q++) {
    let placed = false;
    for (let t = 0; t < MAX_QUAD_ATTEMPTS && !placed; t++) {
      const quad = buildQuad(rand);
      const keys = quad.map(cardKey);
      if (new Set(keys).size !== ROW_SIZE) continue;
      if (keys.some((k) => seen.has(k))) continue;
      for (const card of quad) {
        cards.push(card);
        seen.add(cardKey(card));
      }
      placed = true;
    }
    if (!placed) {
      throw new Error("shapes: could not sample a disjoint valid quad");
    }
  }
  return cards;
}

function shuffledPositions(rand: () => number): number[] {
  const pos = Array.from({ length: CELL_COUNT }, (_, i) => i);
  for (let i = pos.length - 1; i > 0; i--) {
    const j = randInt(rand, i + 1);
    [pos[i], pos[j]] = [pos[j]!, pos[i]!];
  }
  return pos;
}

/** True when some row of the dealt arrangement is already a valid set. */
function hasPresolvedRow(cards: Card[], pos: number[]): boolean {
  for (let r = 0; r < ROW_COUNT; r++) {
    const quad: Card[] = [];
    for (let c = 0; c < ROW_SIZE; c++) quad.push(cards[pos[r * ROW_SIZE + c]!]!);
    if (isValidSet(quad)) return true;
  }
  return false;
}

/**
 * Generate a puzzle with exactly one solution (up to row/card order).
 * Throws after MAX_SOLUTIONS_ATTEMPTS without a unique board (practically
 * unreachable: accidental alternative partitions are rare).
 */
export function generatePuzzle(rand: () => number): ShapesPuzzle {
  for (let attempt = 0; attempt < MAX_SOLUTIONS_ATTEMPTS; attempt++) {
    const cards = sampleSolutionCards(rand);
    for (let s = 0; s < MAX_SHUFFLE_ATTEMPTS; s++) {
      const pos = shuffledPositions(rand);
      if (hasPresolvedRow(cards, pos)) continue;
      if (countSolutions(cards, 2) === 1) return { cards, pos };
      break; // Cards ambiguous regardless of shuffle: resample cards.
    }
  }
  throw new Error("shapes: could not deal a uniquely solvable board");
}
