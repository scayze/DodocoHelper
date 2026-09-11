/**
 * Guaranteed-solvable Minesweeper layout generator: uniform random mine
 * placement, accepted only when a zero-cell opening is fully clearable by
 * logic alone (singles → subset → exact frontier enumeration). The emitted
 * opening is deterministic for a given layout. Framework-free, no DOM.
 */

import { findBestOpening, type Opening, type SolverCaps } from "./solver.js";

export interface GeneratedMines {
  mines: boolean[][];
  opening: Opening;
  /** Candidate layouts tested (1 = first try accepted). */
  attempts: number;
}

export interface GenerateMinesOptions extends SolverCaps {
  maxAttempts?: number;
}

function randomLayout(size: number, mineCount: number, rand: () => number): boolean[][] {
  const total = size * size;
  const order = Array.from({ length: total }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const mines: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  for (let k = 0; k < mineCount; k++) {
    const idx = order[k];
    mines[Math.floor(idx / size)][idx % size] = true;
  }
  return mines;
}

/**
 * Generate a mine layout with a guaranteed no-guess opening. Throws after
 * `maxAttempts` (default 300) — at standard densities acceptance is high,
 * so reaching the cap indicates a bad size/density combo, not bad luck.
 */
export function generateMines(
  size: number,
  mineCount: number,
  rand: () => number = Math.random,
  opts: GenerateMinesOptions = {},
): GeneratedMines {
  if (!Number.isInteger(size) || size < 2) {
    throw new Error(`Minesweeper board size must be an integer >= 2, got ${size}`);
  }
  const maxMines = Math.floor((size * size) / 2);
  if (!Number.isInteger(mineCount) || mineCount < 1 || mineCount > maxMines) {
    throw new Error(`Mine count must be an integer in 1..${maxMines}, got ${mineCount}`);
  }
  const { maxAttempts = 300, ...caps } = opts;
  for (let attempts = 1; attempts <= maxAttempts; attempts++) {
    const mines = randomLayout(size, mineCount, rand);
    const opening = findBestOpening(mines, size, caps);
    if (opening) return { mines, opening, attempts };
  }
  throw new Error(
    `Failed to generate a solvable ${size}x${size}/${mineCount} board in ${maxAttempts} attempts`,
  );
}
