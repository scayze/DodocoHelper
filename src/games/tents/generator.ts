/**
 * Tents and Trees level generator: tents first, trees second. A random
 * no-touch tent set is always solvable by construction (pair each tent with
 * a neighboring tree cell), so the solver only has to confirm the
 * row/column counts are unambiguous. Framework-free, no DOM.
 */

import { ORTHO, TENTS_DEFAULT_SIZE, touchesPlaced, type TentsLevel } from "./logic.js";
import { countSolutions } from "./solver.js";

function shuffled<T>(items: T[], rand: () => number): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function allCells(size: number): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) cells.push([r, c]);
  }
  return cells;
}

/** Greedy no-touch tent placement in random order; null when it gets stuck. */
function placeTents(size: number, count: number, rand: () => number): boolean[][] | null {
  const tents: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  let placed = 0;
  for (const [r, c] of shuffled(allCells(size), rand)) {
    if (placed === count) break;
    if (touchesPlaced(tents, size, r, c)) continue;
    tents[r][c] = true;
    placed++;
  }
  return placed === count ? tents : null;
}

/**
 * Pair every tent with an orthogonal tree cell. A tree cell must be free and
 * may not touch any other tent otherwise that tent would gain a second tree
 * neighbor. Null on dead ends.
 */
function attachTrees(
  tents: boolean[][],
  size: number,
  rand: () => number,
): boolean[][] | null {
  const trees: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  const tentList: Array<[number, number]> = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (tents[r][c]) tentList.push([r, c]);
    }
  }
  for (const [tr, tc] of shuffled(tentList, rand)) {
    const options: Array<[number, number]> = [];
    for (const [dr, dc] of ORTHO) {
      const nr = tr + dr;
      const nc = tc + dc;
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
      if (tents[nr][nc] || trees[nr][nc]) continue;
      let clear = true;
      for (const [er, ec] of ORTHO) {
        const ar = nr + er;
        const ac = nc + ec;
        if (ar < 0 || ar >= size || ac < 0 || ac >= size) continue;
        if ((ar !== tr || ac !== tc) && tents[ar][ac]) {
          clear = false;
          break;
        }
      }
      if (clear) options.push([nr, nc]);
    }
    if (options.length === 0) return null;
    const [r, c] = options[Math.floor(rand() * options.length)];
    trees[r][c] = true;
  }
  return trees;
}

/** One full construction attempt: tents, trees, then a uniqueness check. */
function tryBuild(size: number, count: number, rand: () => number): TentsLevel | null {
  for (let attempt = 0; attempt < 60; attempt++) {
    const tents = placeTents(size, count, rand);
    if (!tents) continue;
    const trees = attachTrees(tents, size, rand);
    if (!trees) continue;
    const { rows, cols } = countsFrom(tents, size);
    const solution: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
    if (countSolutions(trees, rows, cols, 2, solution) !== 1) continue;
    return { size, trees, rowCounts: rows, colCounts: cols, solution };
  }
  return null;
}

function countsFrom(tents: boolean[][], size: number): { rows: number[]; cols: number[] } {
  const rows = Array(size).fill(0);
  const cols = Array(size).fill(0);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (tents[r][c]) {
        rows[r]++;
        cols[c]++;
      }
    }
  }
  return { rows, cols };
}

/** Generate a uniquely solvable level with `count` trees (tents). */
export function generateLevel(
  size = TENTS_DEFAULT_SIZE,
  rand: () => number = Math.random,
): TentsLevel {
  if (!Number.isInteger(size) || size < 2) {
    throw new Error(`Tents board size must be an integer >= 2, got ${size}`);
  }
  // ~1.6 tents per row on the default board (≈13 on 8x8), capped so a
  // no-touch tent set always fits: kings cap is ceil(size/2)^2.
  const maxTents = Math.ceil(size / 2) ** 2;
  const count = Math.max(2, Math.min(Math.round(size * 1.6), maxTents - 2));
  for (let attempt = 0; attempt < 30; attempt++) {
    const level = tryBuild(size, count, rand);
    if (level) return level;
  }
  throw new Error("Failed to generate a tents level");
}
