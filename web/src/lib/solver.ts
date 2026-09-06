import type { CrownPos, NormalizedPuzzle, SolveOptions, SolveResult } from "./types";
import { CROWN, EMPTY } from "./types";
import { validatePuzzleInput } from "./validator";

const U = 0; // unknown
const E = 1; // empty
const K = 2; // crown

interface Targets {
  row: number;
  col: number;
  reg: number;
}

interface State {
  n: number;
  grid: number[];
  regionOf: number[];
  rowPlaced: number[];
  colPlaced: number[];
  regPlaced: number[];
}

const idx = (n: number, r: number, c: number) => r * n + c;

function cloneState(st: State): State {
  return {
    n: st.n,
    grid: st.grid.slice(),
    regionOf: st.regionOf,
    rowPlaced: st.rowPlaced.slice(),
    colPlaced: st.colPlaced.slice(),
    regPlaced: st.regPlaced.slice(),
  };
}

/** Place a crown on an unknown cell; block its neighbors. False on conflict. */
function tryPlaceCrown(st: State, tg: Targets, r: number, c: number): boolean {
  const n = st.n;
  const i = idx(n, r, c);
  if (st.grid[i] === K) return true;
  if (st.grid[i] !== U) return false;
  const g = st.regionOf[i];
  if (st.colPlaced[c] >= tg.col || st.regPlaced[g] >= tg.reg || st.rowPlaced[r] >= tg.row) {
    return false;
  }
  st.grid[i] = K;
  st.rowPlaced[r]++;
  st.colPlaced[c]++;
  st.regPlaced[g]++;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= n || nc < 0 || nc >= n) continue;
      const j = idx(n, nr, nc);
      if (st.grid[j] === K) return false; // adjacent crown -> conflict
      if (st.grid[j] === U) st.grid[j] = E;
    }
  }
  return true;
}

/**
 * Constraint propagation. Maintains the invariant that no unknown cell is
 * adjacent to a crown. Returns false when a contradiction is found.
 */
function propagate(st: State, tg: Targets): boolean {
  const n = st.n;
  let changed = true;
  while (changed) {
    changed = false;

    // 1. crown neighborhoods: unknown neighbors become empty; crown-crown adjacency fails
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (st.grid[idx(n, r, c)] !== K) continue;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = r + dr;
            const nc = c + dc;
            if (nr < 0 || nr >= n || nc < 0 || nc >= n) continue;
            const j = idx(n, nr, nc);
            if (st.grid[j] === K) return false;
            if (st.grid[j] === U) {
              st.grid[j] = E;
              changed = true;
            }
          }
        }
      }
    }

    // per-unit placed/unknown tallies
    const rowUnk = new Array<number>(n).fill(0);
    const colUnk = new Array<number>(n).fill(0);
    const regUnk = new Array<number>(st.regPlaced.length).fill(0);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (st.grid[idx(n, r, c)] === U) {
          rowUnk[r]++;
          colUnk[c]++;
          regUnk[st.regionOf[idx(n, r, c)]]++;
        }
      }
    }

    // 2. overfull / capacity checks
    for (let r = 0; r < n; r++) {
      if (st.rowPlaced[r] > tg.row) return false;
      if (st.rowPlaced[r] + rowUnk[r] < tg.row) return false;
    }
    for (let c = 0; c < n; c++) {
      if (st.colPlaced[c] > tg.col) return false;
      if (st.colPlaced[c] + colUnk[c] < tg.col) return false;
    }
    for (let g = 0; g < st.regPlaced.length; g++) {
      if (st.regPlaced[g] > tg.reg) return false;
      if (st.regPlaced[g] + regUnk[g] < tg.reg) return false;
    }

    // 3. seal completed units: remaining unknowns must be empty
    const seal = (cells: number[]) => {
      for (const j of cells) {
        if (st.grid[j] === U) {
          st.grid[j] = E;
          changed = true;
        }
      }
    };
    for (let r = 0; r < n; r++) {
      if (st.rowPlaced[r] === tg.row && rowUnk[r] > 0) {
        const cells: number[] = [];
        for (let c = 0; c < n; c++) cells.push(idx(n, r, c));
        seal(cells);
      }
    }
    for (let c = 0; c < n; c++) {
      if (st.colPlaced[c] === tg.col && colUnk[c] > 0) {
        const cells: number[] = [];
        for (let r = 0; r < n; r++) cells.push(idx(n, r, c));
        seal(cells);
      }
    }
    for (let g = 0; g < st.regPlaced.length; g++) {
      if (st.regPlaced[g] === tg.reg && regUnk[g] > 0) {
        const cells: number[] = [];
        for (let j = 0; j < n * n; j++) if (st.regionOf[j] === g) cells.push(j);
        seal(cells);
      }
    }
    if (changed) continue; // recount before forcing

    // 4. forced placements: unit whose unknowns exactly fill its need
    const forceUnit = (need: number, cells: number[]): boolean => {
      if (need <= 0) return true;
      let unk = 0;
      for (const j of cells) if (st.grid[j] === U) unk++;
      if (unk === 0 || unk !== need) return true;
      for (const j of cells) {
        if (st.grid[j] !== U) continue;
        const r = Math.floor(j / n);
        const c = j % n;
        if (!tryPlaceCrown(st, tg, r, c)) return false;
      }
      changed = true;
      return true;
    };
    for (let r = 0; r < n; r++) {
      const need = tg.row - st.rowPlaced[r];
      if (need > 0) {
        const cells: number[] = [];
        for (let c = 0; c < n; c++) cells.push(idx(n, r, c));
        if (!forceUnit(need, cells)) return false;
      }
    }
    for (let c = 0; c < n; c++) {
      const need = tg.col - st.colPlaced[c];
      if (need > 0) {
        const cells: number[] = [];
        for (let r = 0; r < n; r++) cells.push(idx(n, r, c));
        if (!forceUnit(need, cells)) return false;
      }
    }
    for (let g = 0; g < st.regPlaced.length; g++) {
      const need = tg.reg - st.regPlaced[g];
      if (need > 0) {
        const cells: number[] = [];
        for (let j = 0; j < n * n; j++) if (st.regionOf[j] === g) cells.push(j);
        if (!forceUnit(need, cells)) return false;
      }
    }
  }
  return true;
}

/** All legal crown pairs for row r (cells must be unknown here). */
function legalPairsForRow(st: State, tg: Targets, r: number): Array<[number, number]> {
  const n = st.n;
  const need = tg.row - st.rowPlaced[r];
  if (need <= 0) return [];
  const cand: number[] = [];
  for (let c = 0; c < n; c++) {
    const j = idx(n, r, c);
    if (st.grid[j] !== U) continue;
    if (st.colPlaced[c] >= tg.col) continue;
    if (st.regPlaced[st.regionOf[j]] >= tg.reg) continue;
    cand.push(c);
  }
  if (cand.length < need) return [];
  if (need === 1) return cand.map((c) => [c, -1] as [number, number]);
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      const c1 = cand[i];
      const c2 = cand[j];
      if (Math.abs(c1 - c2) < 2) continue; // same-row touch
      const g1 = st.regionOf[idx(n, r, c1)];
      const g2 = st.regionOf[idx(n, r, c2)];
      if (g1 === g2 && st.regPlaced[g1] + 2 > tg.reg) continue;
      pairs.push([c1, c2]);
    }
  }
  // Prefer columns/regions that are still hungry (better pruning).
  const hunger = (c: number) =>
    tg.col - st.colPlaced[c] + (tg.reg - st.regPlaced[st.regionOf[idx(n, r, c)]]);
  pairs.sort((a, b) => hunger(b[0]) + hunger(b[1]) - (hunger(a[0]) + hunger(a[1])));
  return pairs;
}

interface SearchCtx {
  tg: Targets;
  nodes: number;
  budget: number;
  limit: number;
  out: State[];
  exhausted: boolean;
}

function search(st: State, ctx: SearchCtx): void {
  if (ctx.out.length >= ctx.limit || ctx.exhausted) return;
  if (++ctx.nodes > ctx.budget) {
    ctx.exhausted = true;
    return;
  }
  if (!propagate(st, ctx.tg)) return;

  const n = st.n;
  // MRV: unfinished row with fewest legal pairs
  let bestRow = -1;
  let bestPairs: Array<[number, number]> | null = null;
  for (let r = 0; r < n; r++) {
    if (st.rowPlaced[r] === ctx.tg.row) continue;
    const pairs = legalPairsForRow(st, ctx.tg, r);
    if (pairs.length === 0) return; // dead end
    if (bestPairs === null || pairs.length < bestPairs.length) {
      bestPairs = pairs;
      bestRow = r;
      if (pairs.length === 1) break;
    }
  }
  if (bestRow === -1) {
    // Every row satisfied; columns/regions must be satisfied too.
    for (let c = 0; c < n; c++) if (st.colPlaced[c] !== ctx.tg.col) return;
    for (let g = 0; g < st.regPlaced.length; g++) if (st.regPlaced[g] !== ctx.tg.reg) return;
    ctx.out.push(st);
    return;
  }
  for (const [c1, c2] of bestPairs as Array<[number, number]>) {
    const ns = cloneState(st);
    let ok = tryPlaceCrown(ns, ctx.tg, bestRow, c1);
    if (ok && c2 !== -1) ok = tryPlaceCrown(ns, ctx.tg, bestRow, c2);
    if (!ok) continue;
    search(ns, ctx);
    if (ctx.out.length >= ctx.limit || ctx.exhausted) return;
  }
}

function buildInitialState(puzzle: NormalizedPuzzle): { state: State; tg: Targets } {
  const n = puzzle.size;
  const regionOf = new Array<number>(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) regionOf[idx(n, r, c)] = puzzle.regions[r][c];
  }
  const state: State = {
    n,
    grid: new Array<number>(n * n).fill(U),
    regionOf,
    rowPlaced: new Array<number>(n).fill(0),
    colPlaced: new Array<number>(n).fill(0),
    regPlaced: new Array<number>(puzzle.regionCount).fill(0),
  };
  const tg: Targets = {
    row: puzzle.crownsPerRow,
    col: puzzle.crownsPerColumn,
    reg: puzzle.crownsPerRegion,
  };
  return { state, tg };
}

function stateToGrid(st: State): { grid: string[][]; crowns: CrownPos[] } {
  const grid: string[][] = [];
  const crowns: CrownPos[] = [];
  for (let r = 0; r < st.n; r++) {
    const row: string[] = [];
    for (let c = 0; c < st.n; c++) {
      const v = st.grid[idx(st.n, r, c)];
      row.push(v === K ? CROWN : EMPTY);
      if (v === K) crowns.push({ r, c });
    }
    grid.push(row);
  }
  return { grid, crowns };
}

/** Solve; collects up to `limit` solutions. Empty array = unsolvable. */
export function solveAll(
  puzzle: NormalizedPuzzle,
  options: SolveOptions = {},
): Array<{ grid: string[][]; crowns: CrownPos[] }> {
  const limit = options.limit ?? 1;
  const budget = options.budget ?? 2_000_000;
  const { state, tg } = buildInitialState(puzzle);

  // Apply givens: forced empties first, then pre-placed crowns.
  for (let r = 0; r < state.n; r++) {
    for (let c = 0; c < state.n; c++) {
      if (puzzle.initial[r][c] === EMPTY) state.grid[idx(state.n, r, c)] = E;
    }
  }
  for (let r = 0; r < state.n; r++) {
    for (let c = 0; c < state.n; c++) {
      if (puzzle.initial[r][c] === CROWN) {
        if (!tryPlaceCrown(state, tg, r, c)) return [];
      }
    }
  }
  const ctx: SearchCtx = { tg, nodes: 0, budget, limit, out: [], exhausted: false };
  search(state, ctx);
  return ctx.out.map(stateToGrid);
}

/** Full entry point: validate raw JSON, then solve. */
export function solvePuzzle(raw: unknown, options: SolveOptions = {}): SolveResult {
  const { errors, puzzle } = validatePuzzleInput(raw);
  if (!puzzle) return { status: "invalid", solution: null, crowns: null, errors };
  const found = solveAll(puzzle, options);
  if (found.length === 0) {
    return {
      status: "unsolvable",
      solution: null,
      crowns: null,
      errors: ["no solution satisfies all constraints"],
    };
  }
  return { status: "solved", solution: found[0].grid, crowns: found[0].crowns, errors: [] };
}
