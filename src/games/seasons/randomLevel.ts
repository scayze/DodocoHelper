/**
 * Random-fill Seasons levels with guaranteed solvability.
 *
 * The fast path is a uniform i.i.d. fill over the four season types — the same
 * distribution as a "completely random" board — emitted only after the exact
 * solver proves it fully clearable. Rare failures go through a monotonic
 * repair ladder with re-verification after each step, and only then a fresh
 * fill. Typical output has zero edits, i.e. the raw uniform distribution
 * conditioned on solvability. Framework-free, no DOM.
 */

import {
  SEASONS_SIZE,
  SEASON_TYPES,
  type SeasonsCell,
  type SeasonType,
} from "./logic.js";
import { isSolvableTypes, type SolverOutcome } from "./solver.js";

export interface RandomLevelOptions {
  /** Defaults to Math.random. Seeded functions give reproducible boards. */
  rand?: () => number;
  /** Per-verify solver caps. Defaults bound the heavy tail, not the typical case. */
  verifyStates?: number;
  verifyMs?: number;
  /** Count-preserving swaps tried per fill before giving up on it. Default 10. */
  maxSwaps?: number;
  /** Fresh fills before giving up entirely (practically unreachable). Default 10. */
  maxFills?: number;
  /** Track the solver's clearing path (free hint data). Default true. */
  solution?: boolean;
}

export interface RandomLevelEdits {
  /** Single-tile recolors (lone-color fixes + singleton pairings). */
  recolors: number;
  /** Type swaps (color histogram untouched). */
  swaps: number;
}

export interface RandomLevel {
  cells: SeasonsCell[][];
  rows: number;
  cols: number;
  /** Clearing moves as flat row-major indices, in play order; null when disabled. */
  solution: number[][] | null;
  edits: RandomLevelEdits;
  fills: number;
  verifies: number;
  ms: number;
}

const DEFAULT_VERIFY_STATES = 500_000;
const DEFAULT_VERIFY_MS = 250;
const DEFAULT_MAX_SWAPS = 10;
const DEFAULT_MAX_FILLS = 10;

function randInt(rand: () => number, n: number): number {
  return Math.floor(rand() * n);
}

function resolveDims(size: number | { rows: number; cols: number }): {
  rows: number;
  cols: number;
} {
  if (typeof size === "number") return { rows: size, cols: size };
  return { rows: size.rows, cols: size.cols };
}

/** Numeric grid codes 0..3 index SEASON_TYPES; no empties during generation. */
function uniformFill(
  rows: number,
  cols: number,
  rand: () => number,
): Uint8Array {
  const data = new Uint8Array(rows * cols);
  for (let i = 0; i < data.length; i++) data[i] = randInt(rand, 4);
  return data;
}

function orthogonalNeighbors(
  idx: number,
  rows: number,
  cols: number,
): number[] {
  const r = Math.floor(idx / cols);
  const c = idx % cols;
  const out: number[] = [];
  if (r > 0) out.push(idx - cols);
  if (r + 1 < rows) out.push(idx + cols);
  if (c > 0) out.push(idx - 1);
  if (c + 1 < cols) out.push(idx + 1);
  return out;
}

function colorCounts(data: Uint8Array): [number, number, number, number] {
  const counts: [number, number, number, number] = [0, 0, 0, 0];
  for (const v of data) counts[v as 0 | 1 | 2 | 3]++;
  return counts;
}

/** Flat indices of tiles with no equal orthogonal neighbor. */
function findSingles(
  data: Uint8Array,
  rows: number,
  cols: number,
): number[] {
  const singles: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const t = data[i];
    const r = Math.floor(i / cols);
    const c = i % cols;
    if (r > 0 && data[i - cols] === t) continue;
    if (r + 1 < rows && data[i + cols] === t) continue;
    if (c > 0 && data[i - 1] === t) continue;
    if (c + 1 < cols && data[i + 1] === t) continue;
    singles.push(i);
  }
  return singles;
}

function toTypeGrid(
  data: Uint8Array,
  rows: number,
  cols: number,
): (SeasonType | null)[][] {
  const grid: (SeasonType | null)[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: (SeasonType | null)[] = [];
    for (let c = 0; c < cols; c++) row.push(SEASON_TYPES[data[r * cols + c]]);
    grid.push(row);
  }
  return grid;
}

function toCells(
  data: Uint8Array,
  rows: number,
  cols: number,
): SeasonsCell[][] {
  const cells: SeasonsCell[][] = [];
  let id = 1;
  for (let r = 0; r < rows; r++) {
    const row: SeasonsCell[] = [];
    for (let c = 0; c < cols; c++) {
      row.push({ t: SEASON_TYPES[data[r * cols + c]], id: id++ });
    }
    cells.push(row);
  }
  return cells;
}

/**
 * Uniform random fill, accepted only when the exact solver proves it fully
 * clearable. Repair ladder per fill: forced lone-color recolors (a color seen
 * exactly once can never clear, so the edit is necessary, not a guess), then
 * singleton pairing (each step strictly decreases the singleton count, so the
 * phase terminates), then bounded count-preserving swaps. Falls back to a
 * fresh fill; only solver-accepted boards are ever emitted.
 */
export function generateRandomLevel(
  size: number | { rows: number; cols: number } = SEASONS_SIZE,
  opts: RandomLevelOptions = {},
): RandomLevel {
  const { rows, cols } = resolveDims(size);
  if (
    !Number.isInteger(rows) ||
    !Number.isInteger(cols) ||
    rows < 2 ||
    cols < 2
  ) {
    throw new Error(
      `Random level dims must be integers >= 2, got ${rows}x${cols}`,
    );
  }
  const rand = opts.rand ?? Math.random;
  const verifyStates = opts.verifyStates ?? DEFAULT_VERIFY_STATES;
  const verifyMs = opts.verifyMs ?? DEFAULT_VERIFY_MS;
  const maxSwaps = opts.maxSwaps ?? DEFAULT_MAX_SWAPS;
  const maxFills = opts.maxFills ?? DEFAULT_MAX_FILLS;
  const wantSolution = opts.solution ?? true;

  const t0 = Date.now();
  let fills = 0;
  let verifies = 0;
  let recolors = 0;
  let swaps = 0;

  const verify = (data: Uint8Array): SolverOutcome => {
    verifies++;
    return isSolvableTypes(toTypeGrid(data, rows, cols), {
      maxStates: verifyStates,
      maxMs: verifyMs,
      trackSolution: wantSolution,
    });
  };
  const accept = (data: Uint8Array, outcome: SolverOutcome): RandomLevel => ({
    cells: toCells(data, rows, cols),
    rows,
    cols,
    solution: outcome.solution ?? null,
    edits: { recolors, swaps },
    fills,
    verifies,
    ms: Date.now() - t0,
  });

  for (let f = 0; f < maxFills; f++) {
    fills++;
    const data = uniformFill(rows, cols, rand);

    let outcome = verify(data);
    if (outcome.result === "solvable") return accept(data, outcome);

    // Phase B: recolor lone-color tiles (at most 4 exist). Joining a random
    // neighbor's type can never create a new lone color: the old type goes
    // extinct (0, not 1) and the new type only grows.
    for (let guard = 0; guard < 4; guard++) {
      const counts = colorCounts(data);
      let lone = -1;
      for (let t = 0; t < 4; t++) {
        if (counts[t as 0 | 1 | 2 | 3] === 1) {
          lone = t;
          break;
        }
      }
      if (lone < 0) break;
      const idx = data.indexOf(lone);
      const nbs = orthogonalNeighbors(idx, rows, cols);
      data[idx] = data[nbs[randInt(rand, nbs.length)]];
      recolors++;
    }
    outcome = verify(data);
    if (outcome.result === "solvable") return accept(data, outcome);

    // Phase C: pair singletons one at a time, verifying after each edit so
    // the first solvable board wins (minimal drift). Recoloring a singleton
    // to a neighbor's type strictly decreases the singleton count — it has
    // no same-type neighbors to orphan — so this loop always terminates.
    for (let guard = 0; guard < rows * cols; guard++) {
      const singles = findSingles(data, rows, cols);
      if (singles.length === 0) break;
      const idx = singles[randInt(rand, singles.length)];
      const nbs = orthogonalNeighbors(idx, rows, cols);
      data[idx] = data[nbs[randInt(rand, nbs.length)]];
      recolors++;
      outcome = verify(data);
      if (outcome.result === "solvable") return accept(data, outcome);
    }

    // Phase D: bounded type swaps. The color histogram is untouched; only
    // adjacency changes.
    for (let s = 0; s < maxSwaps; s++) {
      const a = randInt(rand, data.length);
      let b = randInt(rand, data.length);
      if (b === a) b = (b + 1) % data.length;
      const t = data[a];
      data[a] = data[b];
      data[b] = t;
      swaps++;
      outcome = verify(data);
      if (outcome.result === "solvable") return accept(data, outcome);
    }
    // Otherwise: fresh fill (loop continues).
  }
  throw new Error(
    `Failed to generate a random solvable level in ${maxFills} fills`,
  );
}
