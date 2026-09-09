/** Exact Seasons solvability checker: DFS over the reachable-state DAG with memo. No DOM. */

import type { SeasonType } from "./logic.js";

export type SolverResult = "solvable" | "unsolvable" | "unknown";

export interface SolverOptions {
  /** Cap on distinct boards visited (including the start). Default 500000. */
  maxStates?: number;
  /** Wall-clock budget in ms. Default 5000. Checked each expansion. */
  maxMs?: number;
  /**
   * When true, the outcome includes the clearing move path (regions as
   * flat row-major indices, in play order). Costs extra memory; default false.
   */
  trackSolution?: boolean;
}

export interface SolverOutcome {
  result: SolverResult;
  /** Distinct boards visited. */
  states: number;
  ms: number;
  /** Present only when result is solvable and trackSolution was set. */
  solution?: number[][];
}

const DEFAULT_MAX_STATES = 500_000;
const DEFAULT_MAX_MS = 5_000;

function typeCode(t: SeasonType): number {
  switch (t) {
    case "summer":
      return 1;
    case "autumn":
      return 2;
    case "spring":
      return 3;
    case "winter":
      return 4;
  }
}

function encode(board: Uint8Array): string {
  let s = "";
  for (let i = 0; i < board.length; i++) s += String.fromCharCode(board[i]);
  return s;
}

/** Distinct removable regions (size >= 2) as flat-index lists. Single flood-fill pass. */
function enumerateRegions(
  board: Uint8Array,
  rows: number,
  cols: number,
): number[][] {
  const n = rows * cols;
  const seen = new Uint8Array(n);
  const regions: number[][] = [];
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (board[i] === 0 || seen[i] !== 0) continue;
    const t = board[i];
    stack.length = 0;
    stack.push(i);
    seen[i] = 1;
    const region: number[] = [];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      region.push(cur);
      const r = (cur / cols) | 0;
      const c = cur % cols;
      if (r > 0) {
        const nb = cur - cols;
        if (seen[nb] === 0 && board[nb] === t) {
          seen[nb] = 1;
          stack.push(nb);
        }
      }
      if (r + 1 < rows) {
        const nb = cur + cols;
        if (seen[nb] === 0 && board[nb] === t) {
          seen[nb] = 1;
          stack.push(nb);
        }
      }
      if (c > 0) {
        const nb = cur - 1;
        if (seen[nb] === 0 && board[nb] === t) {
          seen[nb] = 1;
          stack.push(nb);
        }
      }
      if (c + 1 < cols) {
        const nb = cur + 1;
        if (seen[nb] === 0 && board[nb] === t) {
          seen[nb] = 1;
          stack.push(nb);
        }
      }
    }
    if (region.length >= 2) regions.push(region);
  }
  return regions;
}

/**
 * Remove a region then apply Seasons gravity (bottom-justify each column)
 * and column collapse (survivors shift right, order preserved).
 */
function applyMove(
  board: Uint8Array,
  rows: number,
  cols: number,
  region: number[],
): Uint8Array {
  const next = Uint8Array.from(board);
  for (const i of region) next[i] = 0;
  // Gravity: bottom-justify each column in place.
  for (let c = 0; c < cols; c++) {
    let write = rows - 1;
    for (let r = rows - 1; r >= 0; r--) {
      const v = next[r * cols + c];
      if (v !== 0) {
        next[write * cols + c] = v;
        if (write !== r) next[r * cols + c] = 0;
        write--;
      }
    }
  }
  // Collapse: surviving columns shift right, empties pad the left.
  const kept: number[] = [];
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      if (next[r * cols + c] !== 0) {
        kept.push(c);
        break;
      }
    }
  }
  if (kept.length < cols) {
    const pad = cols - kept.length;
    const tmp = new Uint8Array(rows * cols);
    for (let k = 0; k < kept.length; k++) {
      const src = kept[k];
      const dst = pad + k;
      for (let r = 0; r < rows; r++) tmp[r * cols + dst] = next[r * cols + src];
    }
    return tmp;
  }
  return next;
}

/** True when the board is trivially dead: a color appears exactly once (or one tile left). */
function prunedByColorCount(board: Uint8Array): boolean {
  let c1 = 0;
  let c2 = 0;
  let c3 = 0;
  let c4 = 0;
  let total = 0;
  for (let i = 0; i < board.length; i++) {
    const v = board[i];
    if (v === 1) {
      c1++;
      total++;
    } else if (v === 2) {
      c2++;
      total++;
    } else if (v === 3) {
      c3++;
      total++;
    } else if (v === 4) {
      c4++;
      total++;
    }
  }
  if (total === 0) return false; // cleared — handled by caller, not a prune
  if (total === 1) return true;
  return c1 === 1 || c2 === 1 || c3 === 1 || c4 === 1;
}

function solveNumeric(
  start: Uint8Array,
  rows: number,
  cols: number,
  opts: SolverOptions,
): SolverOutcome {
  const maxStates = opts.maxStates ?? DEFAULT_MAX_STATES;
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
  const t0 = Date.now();
  // Empty start is trivially solved.
  let empty = true;
  for (let i = 0; i < start.length; i++) {
    if (start[i] !== 0) {
      empty = false;
      break;
    }
  }
  if (empty) return { result: "solvable", states: 1, ms: 0 };
  if (prunedByColorCount(start)) return { result: "unsolvable", states: 1, ms: 0 };

  const startKey = encode(start);
  const visited = new Set<string>([startKey]);
  const stack: Array<{ board: Uint8Array; key: string }> = [
    { board: start, key: startKey },
  ];
  // Child-board key -> { parent key, region played (flat indices) }. Only
  // populated when trackSolution is set.
  const parent =
    (opts.trackSolution ?? false)
      ? new Map<string, { parent: string; region: number[] }>()
      : null;
  let states = 1;
  let expansions = 0;

  const buildSolution = (winKey: string): number[][] => {
    const moves: number[][] = [];
    let key: string | undefined = winKey;
    while (key !== undefined && key !== startKey) {
      const step = parent!.get(key);
      if (!step) break;
      moves.push(step.region);
      key = step.parent;
    }
    moves.reverse();
    return moves;
  };

  while (stack.length > 0) {
    if (states >= maxStates) {
      return { result: "unknown", states, ms: Date.now() - t0 };
    }
    if ((expansions & 63) === 0 && Date.now() - t0 > maxMs) {
      return { result: "unknown", states, ms: Date.now() - t0 };
    }
    expansions++;
    const { board: cur, key: curKey } = stack.pop()!;
    const regions = enumerateRegions(cur, rows, cols);
    if (regions.length === 0) continue;
    // Largest first: finds a clearing path early when one exists.
    regions.sort((a, b) => b.length - a.length);
    for (const region of regions) {
      const next = applyMove(cur, rows, cols, region);
      // Fast clear check without encoding.
      let any = false;
      for (let i = 0; i < next.length; i++) {
        if (next[i] !== 0) {
          any = true;
          break;
        }
      }
      if (!any) {
        const ms = Date.now() - t0;
        if (parent === null) return { result: "solvable", states, ms };
        // The final move clears everything, so the win key is all-zeros.
        const winKey = encode(next);
        visited.add(winKey);
        parent.set(winKey, { parent: curKey, region });
        return {
          result: "solvable",
          states,
          ms,
          solution: buildSolution(winKey),
        };
      }
      if (prunedByColorCount(next)) continue;
      const key = encode(next);
      if (visited.has(key)) continue;
      visited.add(key);
      states++;
      if (parent !== null) parent.set(key, { parent: curKey, region });
      stack.push({ board: next, key });
      if (states >= maxStates) {
        return { result: "unknown", states, ms: Date.now() - t0 };
      }
    }
  }
  return { result: "unsolvable", states, ms: Date.now() - t0 };
}

/** Solve a plain type grid. Convenient for tests and benchmarks on random fills. */
export function isSolvableTypes(
  grid: (SeasonType | null)[][],
  opts: SolverOptions = {},
): SolverOutcome {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  if (rows === 0 || cols === 0) return { result: "solvable", states: 0, ms: 0 };
  const board = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const t = grid[r][c];
      board[r * cols + c] = t === null ? 0 : typeCode(t);
    }
  }
  return solveNumeric(board, rows, cols, opts);
}
