import type { CrownPos, NormalizedPuzzle, SolveOptions, SolveResult } from "./types.js";
import { CROWN, EMPTY } from "./types.js";
import { validatePuzzleInput } from "./validator.js";

export const U = 0;
export const E = 1;
export const K = 2;

export interface Targets {
  row: number;
  col: number;
  reg: number;
}

export interface State {
  n: number;
  grid: number[];
  regionOf: number[];
  rowPlaced: number[];
  colPlaced: number[];
  regPlaced: number[];
}

export interface ContradictionWitness {
  kind: "adjacency" | "overfull" | "starved" | "no-placement" | "search";
  scope: "row" | "column" | "region" | "neighbors" | "search";
  unit?: number;
  cells: string[];
  placed?: number;
  needed?: number;
  available?: number;
}

export type AssumptionResult = "solved" | "unsatisfiable" | "unknown";

export interface AssumptionDetails {
  status: AssumptionResult;
  nodes: number;
  witness: ContradictionWitness | null;
}

const idx = (n: number, r: number, c: number) => r * n + c;
const pos = (r: number, c: number) => `${r},${c}`;

// ---------------------------------------------------------------------------
// Basic board ops
// ---------------------------------------------------------------------------

export function buildInitialState(puzzle: NormalizedPuzzle): { state: State; tg: Targets } {
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

function allUnitPos(st: State, scope: "row" | "column" | "region", unit: number): string[] {
  const out: string[] = [];
  for (let r = 0; r < st.n; r++) {
    for (let c = 0; c < st.n; c++) {
      if (
        (scope === "row" && r === unit) ||
        (scope === "column" && c === unit) ||
        (scope === "region" && st.regionOf[idx(st.n, r, c)] === unit)
      )
        out.push(pos(r, c));
    }
  }
  return out;
}

/** Mark a crown without touching its neighbours (adjacency is handled by propagate).
 *  Returns false on conflict. */
export function markCrown(st: State, tg: Targets, r: number, c: number): boolean {
  const n = st.n;
  const i = idx(n, r, c);
  if (st.grid[i] !== U) return false;
  const g = st.regionOf[i];
  if (st.colPlaced[c] >= tg.col || st.regPlaced[g] >= tg.reg || st.rowPlaced[r] >= tg.row) return false;
  st.grid[i] = K;
  st.rowPlaced[r]++;
  st.colPlaced[c]++;
  st.regPlaced[g]++;
  return true;
}

/** Place a crown on an unknown cell and cross its 8 neighbours. Returns false on conflict. */
export function tryPlaceCrown(st: State, tg: Targets, r: number, c: number): boolean {
  const n = st.n;
  const i = idx(n, r, c);
  if (st.grid[i] === K) return true;
  if (st.grid[i] !== U) return false;
  const g = st.regionOf[i];
  if (st.colPlaced[c] >= tg.col || st.regPlaced[g] >= tg.reg || st.rowPlaced[r] >= tg.row) return false;

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
      if (st.grid[j] === K) return false;
      if (st.grid[j] === U) st.grid[j] = E;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Core propagation (D1 crown-neighbour + D2 unit-complete + consistency)
// ---------------------------------------------------------------------------

export function propagate(st: State, tg: Targets): ContradictionWitness | null {
  const n = st.n;
  let changed = true;

  while (changed) {
    changed = false;

    // Crown neighbourhoods → crosses (D1)
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
            if (st.grid[j] === K) {
              return { kind: "adjacency", scope: "neighbors", cells: [pos(r, c), pos(nr, nc)] };
            }
            if (st.grid[j] === U) {
              st.grid[j] = E;
              changed = true;
            }
          }
        }
      }
    }

    // Tallies
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

    // Consistency (overfull / starved)
    for (let r = 0; r < n; r++) {
      if (st.rowPlaced[r] > tg.row)
        return { kind: "overfull", scope: "row", unit: r, cells: allUnitPos(st, "row", r), placed: st.rowPlaced[r], needed: tg.row };
      if (st.rowPlaced[r] + rowUnk[r] < tg.row)
        return { kind: "starved", scope: "row", unit: r, cells: allUnitPos(st, "row", r), placed: st.rowPlaced[r], needed: tg.row, available: rowUnk[r] };
    }
    for (let c = 0; c < n; c++) {
      if (st.colPlaced[c] > tg.col)
        return { kind: "overfull", scope: "column", unit: c, cells: allUnitPos(st, "column", c), placed: st.colPlaced[c], needed: tg.col };
      if (st.colPlaced[c] + colUnk[c] < tg.col)
        return { kind: "starved", scope: "column", unit: c, cells: allUnitPos(st, "column", c), placed: st.colPlaced[c], needed: tg.col, available: colUnk[c] };
    }
    for (let g = 0; g < st.regPlaced.length; g++) {
      if (st.regPlaced[g] > tg.reg)
        return { kind: "overfull", scope: "region", unit: g, cells: allUnitPos(st, "region", g), placed: st.regPlaced[g], needed: tg.reg };
      if (st.regPlaced[g] + regUnk[g] < tg.reg)
        return { kind: "starved", scope: "region", unit: g, cells: allUnitPos(st, "region", g), placed: st.regPlaced[g], needed: tg.reg, available: regUnk[g] };
    }

    // Seal completed units (D2)
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
    if (changed) continue;

    // Simple exact match: unit has exactly as many unknowns as needed (D3 basic)
    const forceUnit = (need: number, cells: number[]): ContradictionWitness | null | true => {
      if (need <= 0) return true;
      let unk = 0;
      for (const j of cells) if (st.grid[j] === U) unk++;
      if (unk === 0 || unk !== need) return true;
      for (const j of cells) {
        if (st.grid[j] !== U) continue;
        const r = Math.floor(j / n);
        const c = j % n;
        if (!tryPlaceCrown(st, tg, r, c)) {
          return { kind: "no-placement", scope: "region", unit: 0, cells: [], needed: need }; // scope filled by caller
        }
      }
      changed = true;
      return true;
    };

    for (let r = 0; r < n; r++) {
      const need = tg.row - st.rowPlaced[r];
      if (need > 0) {
        const cells: number[] = [];
        for (let c = 0; c < n; c++) cells.push(idx(n, r, c));
        const res = forceUnit(need, cells);
        if (res !== true) {
          return { kind: "no-placement", scope: "row", unit: r, cells: allUnitPos(st, "row", r), needed: need };
        }
      }
    }
    for (let c = 0; c < n; c++) {
      const need = tg.col - st.colPlaced[c];
      if (need > 0) {
        const cells: number[] = [];
        for (let r = 0; r < n; r++) cells.push(idx(n, r, c));
        const res = forceUnit(need, cells);
        if (res !== true) {
          return { kind: "no-placement", scope: "column", unit: c, cells: allUnitPos(st, "column", c), needed: need };
        }
      }
    }
    for (let g = 0; g < st.regPlaced.length; g++) {
      const need = tg.reg - st.regPlaced[g];
      if (need > 0) {
        const cells: number[] = [];
        for (let j = 0; j < n * n; j++) if (st.regionOf[j] === g) cells.push(j);
        const res = forceUnit(need, cells);
        if (res !== true) {
          return { kind: "no-placement", scope: "region", unit: g, cells: allUnitPos(st, "region", g), needed: need };
        }
      }
    }
  }

  return null;
}

export function isStateSolved(st: State, tg: Targets): boolean {
  for (let i = 0; i < st.grid.length; i++) if (st.grid[i] === U) return false;
  for (let i = 0; i < st.rowPlaced.length; i++) if (st.rowPlaced[i] !== tg.row) return false;
  for (let i = 0; i < st.colPlaced.length; i++) if (st.colPlaced[i] !== tg.col) return false;
  for (let i = 0; i < st.regPlaced.length; i++) if (st.regPlaced[i] !== tg.reg) return false;
  return true;
}

export function stateToGrid(st: State): { grid: string[][]; crowns: CrownPos[] } {
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

// ---------------------------------------------------------------------------
// Deduction rules
// ---------------------------------------------------------------------------

export interface Step {
  r: number;
  c: number;
  to: typeof K | typeof E;
  rule: string;
  reason: string;
}

/** Apply a list of steps to a mutable state. Returns false if a step is illegal. */
function applySteps(st: State, tg: Targets, steps: Step[]): boolean {
  for (const s of steps) {
    const i = idx(st.n, s.r, s.c);
    if (st.grid[i] !== U) continue;
    if (s.to === K) {
      if (!tryPlaceCrown(st, tg, s.r, s.c)) return false;
    } else {
      st.grid[i] = E;
    }
  }
  return true;
}

// ---- D3 advanced: 1-D exact fit (rows + columns) ----

function forcedIn1D(st: State, tg: Targets, cells: number[], need: number, isRow: boolean): Step[] {
  const n = st.n;
  const out: Step[] = [];
  if (cells.length < need || need <= 0) return out;

  const placements: number[][] = [];
  const tryPlace = (start: number, chosen: number[]) => {
    if (chosen.length === need) {
      placements.push([...chosen]);
      return;
    }
    const remaining = need - chosen.length;
    for (let i = start; i <= cells.length - remaining; i++) {
      const ci = cells[i];
      const cr = Math.floor(ci / n);
      const cc = ci % n;

      if (isRow) {
        if (st.colPlaced[cc] >= tg.col) continue;
        if (st.regPlaced[st.regionOf[ci]] >= tg.reg) continue;
      } else {
        if (st.rowPlaced[cr] >= tg.row) continue;
        if (st.regPlaced[st.regionOf[ci]] >= tg.reg) continue;
      }

      if (chosen.length > 0) {
        const prev = chosen[chosen.length - 1];
        const pr = Math.floor(prev / n);
        const pc = prev % n;
        if (isRow) {
          if (Math.abs(cc - pc) <= 1) continue;
        } else {
          if (Math.abs(cr - pr) <= 1) continue;
        }
      }

      chosen.push(ci);
      tryPlace(i + 1, chosen);
      chosen.pop();
    }
  };

  tryPlace(0, []);
  if (placements.length === 0) return out;

  const alwaysCrown = new Set(cells);
  const everCrown = new Set<number>();
  for (const p of placements) {
    const set = new Set(p);
    for (const c of cells) if (!set.has(c)) alwaysCrown.delete(c);
    for (const c of p) everCrown.add(c);
  }

  for (const c of alwaysCrown) {
    out.push({ r: Math.floor(c / n), c: c % n, to: K, rule: "1d-fit", reason: `Forced crown in ${isRow ? "row" : "column"} pattern` });
  }
  for (const c of cells) {
    if (!everCrown.has(c)) {
      out.push({ r: Math.floor(c / n), c: c % n, to: E, rule: "1d-fit", reason: `Blocked by ${isRow ? "row" : "column"} pattern` });
    }
  }
  return out;
}

function deduce1D(st: State, tg: Targets): Step[] {
  const n = st.n;
  const out: Step[] = [];

  for (let r = 0; r < n; r++) {
    const need = tg.row - st.rowPlaced[r];
    if (need <= 0) continue;
    const cells: number[] = [];
    for (let c = 0; c < n; c++) {
      const i = idx(n, r, c);
      if (st.grid[i] === U) cells.push(i);
    }
    if (cells.length > 0) out.push(...forcedIn1D(st, tg, cells, need, true));
  }

  for (let c = 0; c < n; c++) {
    const need = tg.col - st.colPlaced[c];
    if (need <= 0) continue;
    const cells: number[] = [];
    for (let r = 0; r < n; r++) {
      const i = idx(n, r, c);
      if (st.grid[i] === U) cells.push(i);
    }
    if (cells.length > 0) out.push(...forcedIn1D(st, tg, cells, need, false));
  }

  return out;
}

// ---- D4 / D6: Critical component / suffocation ----

function deduceCritical(st: State, tg: Targets): Step[] {
  const n = st.n;
  const out: Step[] = [];

  const rowCells: number[][] = Array.from({ length: n }, () => []);
  const colCells: number[][] = Array.from({ length: n }, () => []);
  const regCells: number[][] = Array.from({ length: st.regPlaced.length }, () => []);

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = idx(n, r, c);
      if (st.grid[i] === U) {
        rowCells[r].push(i);
        colCells[c].push(i);
        regCells[st.regionOf[i]].push(i);
      }
    }
  }

  for (let ar = 0; ar < n; ar++) {
    for (let ac = 0; ac < n; ac++) {
      const A = idx(n, ar, ac);
      if (st.grid[A] !== U) continue;

      const aReg = st.regionOf[A];
      let impossible = false;

      // Helper to test a unit
      const testUnit = (cells: number[], need: number, containsA: boolean) => {
        if (need <= 0) return;
        let removed = 0;
        for (const ci of cells) {
          if (ci === A) {
            removed++;
            continue;
          }
          const cr = Math.floor(ci / n);
          const cc = ci % n;
          if (Math.max(Math.abs(cr - ar), Math.abs(cc - ac)) <= 1) removed++;
        }
        const newAvail = cells.length - removed;
        const newNeed = containsA ? need - 1 : need;
        if (newAvail < newNeed) impossible = true;
      };

      // Units containing A
      testUnit(rowCells[ar], tg.row - st.rowPlaced[ar], true);
      if (impossible) {
        out.push({ r: ar, c: ac, to: E, rule: "critical", reason: "Crown here would starve its own row" });
        continue;
      }
      testUnit(colCells[ac], tg.col - st.colPlaced[ac], true);
      if (impossible) {
        out.push({ r: ar, c: ac, to: E, rule: "critical", reason: "Crown here would starve its own column" });
        continue;
      }
      testUnit(regCells[aReg], tg.reg - st.regPlaced[aReg], true);
      if (impossible) {
        out.push({ r: ar, c: ac, to: E, rule: "critical", reason: "Crown here would starve its own region" });
        continue;
      }

      // Nearby units that don't contain A but have cells within king-move
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = ar + dr;
          const nc = ac + dc;
          if (nr < 0 || nr >= n || nc < 0 || nc >= n) continue;
          // Only test units that do NOT also contain A.
          if (dr !== 0) testUnit(rowCells[nr], tg.row - st.rowPlaced[nr], false);
          if (dc !== 0) testUnit(colCells[nc], tg.col - st.colPlaced[nc], false);
          const nReg = st.regionOf[idx(n, nr, nc)];
          if (nReg !== aReg) testUnit(regCells[nReg], tg.reg - st.regPlaced[nReg], false);
          if (impossible) break;
        }
        if (impossible) break;
      }

      if (impossible) {
        out.push({ r: ar, c: ac, to: E, rule: "critical", reason: "Crown here would starve a neighboring unit" });
      }
    }
  }

  return out;
}

// ---- D5: Hall exact cover (unbounded subset size) ----
//
// If k rows together contain every cell of exactly k regions, those k regions
// must fill every crown slot in those rows: no other region may place a crown
// there. The argument is geometric (independent of current marks) and is the
// classic Star Battle "locked set" deduction. Same for columns.
//
// Note: the mirrored deduction (cells OUTSIDE the rows belonging to the k
// covered regions) is vacuous — a fully-contained region has no cells outside
// the rows — so only the in-rows direction exists.

function deduceHall(st: State, tg: Targets): Step[] {
  // Only applies when row/col targets equal region targets (standard Crowns)
  if (tg.row !== tg.reg && tg.col !== tg.reg) return [];
  const n = st.n;

  // Precompute which rows/cols each region occupies (pure geometry).
  const regRows: Set<number>[] = Array.from({ length: st.regPlaced.length }, () => new Set());
  const regCols: Set<number>[] = Array.from({ length: st.regPlaced.length }, () => new Set());
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const g = st.regionOf[idx(n, r, c)];
      regRows[g].add(r);
      regCols[g].add(c);
    }
  }

  const rowDir = tg.row === tg.reg;
  const colDir = tg.col === tg.reg;

  const regionsFullyInside = (units: number[], unitOf: (g: number) => Set<number>) => {
    const inside: number[] = [];
    for (let g = 0; g < st.regPlaced.length; g++) {
      let ok = true;
      for (const u of unitOf(g)) {
        if (!units.includes(u)) {
          ok = false;
          break;
        }
      }
      if (ok) inside.push(g);
    }
    return inside;
  };

  const crossInRows = (rows: number[], covered: Set<number>): Step[] => {
    const out: Step[] = [];
    for (const r of rows) {
      for (let c = 0; c < n; c++) {
        const i = idx(n, r, c);
        if (st.grid[i] !== U || covered.has(st.regionOf[i])) continue;
        out.push({
          r,
          c,
          to: E,
          rule: "hall",
          reason: `These ${rows.length} rows contain every cell of exactly ${covered.size} regions, so only those regions may place a queen here.`,
        });
      }
    }
    return out;
  };

  const crossInCols = (cols: number[], covered: Set<number>): Step[] => {
    const out: Step[] = [];
    for (const c of cols) {
      for (let r = 0; r < n; r++) {
        const i = idx(n, r, c);
        if (st.grid[i] !== U || covered.has(st.regionOf[i])) continue;
        out.push({
          r,
          c,
          to: E,
          rule: "hall",
          reason: `These ${cols.length} columns contain every cell of exactly ${covered.size} regions, so only those regions may place a queen here.`,
        });
      }
    }
    return out;
  };

  if (rowDir) {
    for (let mask = 1; mask < 1 << n; mask++) {
      const rows: number[] = [];
      for (let r = 0; r < n; r++) if (mask & (1 << r)) rows.push(r);
      const covered = regionsFullyInside(rows, (g) => regRows[g]);
      if (rows.length !== covered.length) continue;
      const out = crossInRows(rows, new Set(covered));
      if (out.length > 0) return out;
    }
  }

  if (colDir) {
    for (let mask = 1; mask < 1 << n; mask++) {
      const cols: number[] = [];
      for (let c = 0; c < n; c++) if (mask & (1 << c)) cols.push(c);
      const covered = regionsFullyInside(cols, (g) => regCols[g]);
      if (cols.length !== covered.length) continue;
      const out = crossInCols(cols, new Set(covered));
      if (out.length > 0) return out;
    }
  }

  return [];
}

// ---- D-R1: Region fit (2-D always/never) ----
//
// Place the region's remaining queens inside the region (never touching).
// Enumerate every legal placement (independent set of exactly `need` cells,
// also bounded by row/column quotas) and read off:
//   - cells that appear in EVERY placement  -> forced queen
//   - cells that appear in NO placement     -> forced cross
// The row/column caps make the enumeration tighter but never unsound: any
// real completion restricts to such a placement, so both directions hold.

export interface RuleOutcome {
  witness: ContradictionWitness | null;
  steps: Step[];
}

function starvedRegionWitness(st: State, g: number, need: number): ContradictionWitness {
  return { kind: "starved", scope: "region", unit: g, cells: allUnitPos(st, "region", g), needed: need };
}

export function deduceRegionFit(st: State, tg: Targets): RuleOutcome {
  const n = st.n;
  const steps: Step[] = [];

  for (let g = 0; g < st.regPlaced.length; g++) {
    const need = tg.reg - st.regPlaced[g];
    if (need <= 0) continue;

    const cells: number[] = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const i = idx(n, r, c);
        if (st.regionOf[i] === g && st.grid[i] === U) cells.push(i);
      }
    }
    if (cells.length < need) return { witness: starvedRegionWitness(st, g, need), steps: [] };

    const m = cells.length;
    const capRow = new Array<number>(n);
    const capCol = new Array<number>(n);
    for (let r = 0; r < n; r++) capRow[r] = tg.row - st.rowPlaced[r];
    for (let c = 0; c < n; c++) capCol[c] = tg.col - st.colPlaced[c];
    const rowOf = new Array<number>(m);
    const colOf = new Array<number>(m);
    const adj: boolean[][] = Array.from({ length: m }, () => new Array<boolean>(m).fill(false));
    for (let a = 0; a < m; a++) {
      rowOf[a] = Math.floor(cells[a] / n);
      colOf[a] = cells[a] % n;
      for (let b = a + 1; b < m; b++) {
        const dr = rowOf[a] - Math.floor(cells[b] / n);
        const dc = colOf[a] - cells[b] % n;
        if (Math.max(Math.abs(dr), Math.abs(dc)) <= 1) {
          adj[a][b] = true;
          adj[b][a] = true;
        }
      }
    }

    const inSet = new Array<boolean>(m).fill(false);
    const inRow = new Array<number>(n).fill(0);
    const inCol = new Array<number>(n).fill(0);
    const sets: boolean[][] = [];
    const LIMIT = 50_000;

    const dfs = (start: number, chosen: number): void => {
      if (sets.length > LIMIT) return;
      if (chosen === need) {
        sets.push(inSet.slice());
        return;
      }
      if (m - start < need - chosen) return;
      for (let j = start; j < m; j++) {
        if (sets.length > LIMIT) return;
        if (inRow[rowOf[j]] >= capRow[rowOf[j]] || inCol[colOf[j]] >= capCol[colOf[j]]) continue;
        let adjacent = false;
        for (let t = 0; t < j; t++) {
          if (inSet[t] && adj[t][j]) {
            adjacent = true;
            break;
          }
        }
        if (adjacent) continue;
        inSet[j] = true;
        inRow[rowOf[j]]++;
        inCol[colOf[j]]++;
        dfs(j + 1, chosen + 1);
        inSet[j] = false;
        inRow[rowOf[j]]--;
        inCol[colOf[j]]--;
      }
    };
    dfs(0, 0);

    if (sets.length === 0) return { witness: starvedRegionWitness(st, g, need), steps: [] };
    if (sets.length > LIMIT) continue; // too many placements: no forced cells

    const always = new Set<number>(cells);
    const ever = new Set<number>();
    for (const s of sets) {
      for (let i = 0; i < m; i++) {
        if (s[i]) ever.add(cells[i]);
        else always.delete(cells[i]);
      }
    }
    for (const c of always) steps.push({ r: Math.floor(c / n), c: c % n, to: K, rule: "region-fit", reason: "Every placement of this region's queens includes this cell" });
    for (const c of cells) {
      if (!ever.has(c)) steps.push({ r: Math.floor(c / n), c: c % n, to: E, rule: "region-fit", reason: "No placement of this region's queens uses this cell" });
    }
  }

  return { witness: null, steps };
}

// ---- D-R3: Row-band cover ----
//
// Look at a small band of consecutive rows as a self-contained sub-puzzle:
// every row must place exactly its quota of queens within the band, every
// region may contribute between low_g and high_g queens to the band (from its
// capacity outside), and no column may exceed its quota inside the band.
// Enumerating all band configurations yields always/never cells — the same
// two-direction soundness argument as the region fit, generalised to rows.
// Interval sums that don't match the band's row quota are global
// contradictions (multi-row pigeonhole).

const MAX_BAND_ROWS = 3;
const BAND_NODE_BUDGET = 12_000;

export function deduceBand(st: State, tg: Targets): RuleOutcome {
  for (let size = 2; size <= MAX_BAND_ROWS; size++) {
    for (let top = 0; top + size <= st.n; top++) {
      const rows: number[] = [];
      for (let r = top; r < top + size; r++) rows.push(r);
      const res = bandAnalyze(st, tg, rows);
      if (res.witness || (res.steps.length > 0 && res.steps.length < 200)) return res;
    }
  }
  return { witness: null, steps: [] };
}

function bandAnalyze(st: State, tg: Targets, rows: number[]): RuleOutcome {
  const n = st.n;
  const inRows = new Set(rows);
  const total = rows.length * tg.row;

  // Per-region in-band available cells and outside capacity (unknown cells only).
  const inCells: number[] = new Array(st.regPlaced.length).fill(0);
  const outCells: number[] = new Array(st.regPlaced.length).fill(0);
  let bandCells: number[] = [];
  let lowSum = 0;
  let highSum = 0;
  const low: number[] = new Array(st.regPlaced.length).fill(0);
  const high: number[] = new Array(st.regPlaced.length).fill(0);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = idx(n, r, c);
      if (st.grid[i] !== U) continue;
      const g = st.regionOf[i];
      if (inRows.has(r)) {
        inCells[g]++;
        bandCells.push(i);
      } else {
        outCells[g]++;
      }
    }
  }
  for (let g = 0; g < st.regPlaced.length; g++) {
    low[g] = Math.max(0, tg.reg - outCells[g]);
    high[g] = Math.min(tg.reg, inCells[g]);
    lowSum += low[g];
    highSum += high[g];
  }
  if (lowSum > total) {
    return { witness: { kind: "starved", scope: "row", unit: rows[0], cells: allUnitPos(st, "row", rows[0]), needed: total, available: lowSum }, steps: [] };
  }
  if (highSum < total) {
    return { witness: { kind: "starved", scope: "row", unit: rows[0], cells: allUnitPos(st, "row", rows[0]), needed: total, available: highSum }, steps: [] };
  }
  if (lowSum !== total && highSum !== total) return { witness: null, steps: [] }; // loose window: few marks, skip the DFS
  if (bandCells.length === 0) return { witness: null, steps: [] };

  // Row candidates: the row's unknown cells grouped into legal sets of `quota`.
  const rowCands: Array<Array<number[]>> = rows.map((r) => {
    const cols: number[] = [];
    for (let c = 0; c < n; c++) {
      if (st.grid[idx(n, r, c)] === U) cols.push(c);
    }
    const out: number[][] = [];
    if (tg.row === 1) {
      for (const c of cols) out.push([c]);
    } else {
      for (let a = 0; a < cols.length; a++) {
        for (let b = a + 1; b < cols.length; b++) {
          if (Math.abs(cols[a] - cols[b]) >= 2) out.push([cols[a], cols[b]]);
        }
      }
    }
    return out;
  });

  const count = new Array<number>(st.regPlaced.length).fill(0);
  const colCount = new Array<number>(n).fill(0);
  const confs: Array<Array<Array<number>>> = [];
  let nodes = 0;
  let aborted = false;

  const dfs = (ri: number): void => {
    if (aborted) return;
    if (++nodes > BAND_NODE_BUDGET) {
      aborted = true;
      return;
    }
    if (ri === rows.length) {
      for (let g = 0; g < st.regPlaced.length; g++) {
        if (count[g] < low[g]) return; // a region fell short of its minimum
      }
      confs.push(rowCands.map((_, k) => assigAt[k]));
      if (confs.length > 300) aborted = true;
      return;
    }
    for (const cand of rowCands[ri]) {
      let ok = true;
      for (const c of cand) {
        const g = st.regionOf[idx(n, rows[ri], c)];
        if (count[g] + 1 > high[g]) {
          ok = false;
          break;
        }
        if (colCount[c] + 1 > tg.col) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      for (const c of cand) {
        const g = st.regionOf[idx(n, rows[ri], c)];
        count[g]++;
        colCount[c]++;
      }
      // Forward prune: can the remaining rows still satisfy the global minimum?
      const remaining = (rows.length - ri - 1) * tg.row;
      let lowSumC = 0;
      for (let g = 0; g < st.regPlaced.length; g++) if (count[g] < low[g]) lowSumC += low[g] - count[g];
      if (lowSumC <= remaining) {
        assigAt[ri] = cand;
        dfs(ri + 1);
      }
      for (const c of cand) {
        const g = st.regionOf[idx(n, rows[ri], c)];
        count[g]--;
        colCount[c]--;
      }
      if (aborted) return;
    }
  };
  const assigAt: Array<number[]> = new Array(rows.length);
  dfs(0);
  if (aborted) return { witness: null, steps: [] };
  if (confs.length === 0) {
    // The band admits no completion at all => the whole puzzle is infeasible.
    return { witness: { kind: "starved", scope: "row", unit: rows[0], cells: allUnitPos(st, "row", rows[0]), needed: total }, steps: [] };
  }

  const always = new Set<number>(bandCells);
  const ever = new Set<number>();
  for (const conf of confs) {
    const present = new Set<number>();
    for (let ri = 0; ri < conf.length; ri++) {
      for (const c of conf[ri]) present.add(idx(n, rows[ri], c));
    }
    for (const cell of bandCells) {
      if (!present.has(cell)) always.delete(cell);
      else ever.add(cell);
    }
  }
  const steps: Step[] = [];
  for (const c of always) steps.push({ r: Math.floor(c / n), c: c % n, to: K, rule: "band-cover", reason: "Every way to fill these rows together includes this cell" });
  for (const c of bandCells) {
    if (!ever.has(c)) steps.push({ r: Math.floor(c / n), c: c % n, to: E, rule: "band-cover", reason: "No way to fill these rows together uses this cell" });
  }
  return { witness: null, steps };
}

// ---- Search fallback ----

function legalPairsForRow(st: State, tg: Targets, r: number): Array<[number, number]> {
  const n = st.n;
  const need = tg.row - st.rowPlaced[r];
  if (need <= 0) return [];
  const cand: number[] = [];
  for (let c = 0; c < n; c++) {
    const i = idx(n, r, c);
    if (st.grid[i] !== U) continue;
    if (st.colPlaced[c] >= tg.col) continue;
    if (st.regPlaced[st.regionOf[i]] >= tg.reg) continue;
    cand.push(c);
  }
  if (cand.length < need) return [];
  if (need === 1) return cand.map((c) => [c, -1] as [number, number]);

  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      const c1 = cand[i];
      const c2 = cand[j];
      if (Math.abs(c1 - c2) < 2) continue;
      const g1 = st.regionOf[idx(n, r, c1)];
      const g2 = st.regionOf[idx(n, r, c2)];
      if (g1 === g2 && st.regPlaced[g1] + 2 > tg.reg) continue;
      pairs.push([c1, c2]);
    }
  }
  const hunger = (c: number) => tg.col - st.colPlaced[c] + (tg.reg - st.regPlaced[st.regionOf[idx(n, r, c)]]);
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
  rand?: () => number;
  witness?: ContradictionWitness | null;
}

function starvedWitness(st: State, scope: "row" | "column" | "region", unit: number, need: number): ContradictionWitness {
  const n = st.n;
  let placed = 0;
  let unknown = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const contained =
        (scope === "row" && r === unit) ||
        (scope === "column" && c === unit) ||
        (scope === "region" && st.regionOf[idx(n, r, c)] === unit);
      if (!contained) continue;
      const v = st.grid[idx(n, r, c)];
      if (v === K) placed++;
      if (v === U) unknown++;
    }
  }
  return { kind: "starved", scope, unit, cells: allUnitPos(st, scope, unit), placed, needed: need, available: unknown };
}

function search(st: State, ctx: SearchCtx): void {
  if (ctx.out.length >= ctx.limit || ctx.exhausted) return;
  if (++ctx.nodes > ctx.budget) {
    ctx.exhausted = true;
    return;
  }
  const witness = propagate(st, ctx.tg);
  if (witness) {
    if (!ctx.witness) ctx.witness = witness;
    return;
  }

  const n = st.n;
  let bestRow = -1;
  let bestPairs: Array<[number, number]> | null = null;
  for (let r = 0; r < n; r++) {
    if (st.rowPlaced[r] === ctx.tg.row) continue;
    const pairs = legalPairsForRow(st, ctx.tg, r);
    if (pairs.length === 0) {
      if (!ctx.witness) ctx.witness = starvedWitness(st, "row", r, ctx.tg.row - st.rowPlaced[r]);
      return;
    }
    if (bestPairs === null || pairs.length < bestPairs.length) {
      bestPairs = pairs;
      bestRow = r;
      if (pairs.length === 1) break;
    }
  }
  if (bestRow === -1) {
    for (let c = 0; c < n; c++) if (st.colPlaced[c] !== ctx.tg.col) return;
    for (let g = 0; g < st.regPlaced.length; g++) if (st.regPlaced[g] !== ctx.tg.reg) return;
    ctx.out.push(st);
    return;
  }
  const pairs = bestPairs!;
  if (ctx.rand) shuffleInPlace(pairs, ctx.rand);
  for (const [c1, c2] of pairs) {
    const ns = cloneState(st);
    let ok = tryPlaceCrown(ns, ctx.tg, bestRow, c1);
    if (ok && c2 !== -1) ok = tryPlaceCrown(ns, ctx.tg, bestRow, c2);
    if (!ok) {
      if (!ctx.witness) {
        ctx.witness = c2 !== -1
          ? { kind: "adjacency", scope: "neighbors", cells: [pos(bestRow, c1), pos(bestRow, c2)] }
          : starvedWitness(st, "row", bestRow, ctx.tg.row - st.rowPlaced[bestRow]);
      }
      continue;
    }
    search(ns, ctx);
    if (ctx.out.length >= ctx.limit || ctx.exhausted) return;
  }
}

function shuffleInPlace<T>(arr: T[], rand: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/** Bounded search: returns {found, exhausted, nodes, witness}. */
function searchBounded(st: State, tg: Targets, limit: number, budget: number, rand?: () => number): { found: boolean; exhausted: boolean; nodes: number; witness: ContradictionWitness | null } {
  const ctx: SearchCtx = { tg, nodes: 0, budget, limit, out: [], exhausted: false, rand, witness: null };
  search(st, ctx);
  return { found: ctx.out.length > 0, exhausted: ctx.exhausted, nodes: ctx.nodes, witness: ctx.witness ?? null };
}

// ---------------------------------------------------------------------------
// Deduction engine (public)
// ---------------------------------------------------------------------------

/** Try every advanced rule once and return any forced steps (or the first
 *  rule-proven contradiction). State is NOT mutated. */
export function findForcedSteps(st: State, tg: Targets): RuleOutcome | null {
  const fit = deduce1D(st, tg);
  if (fit.length > 0) return { witness: null, steps: fit };

  const crit = deduceCritical(st, tg);
  if (crit.length > 0) return { witness: null, steps: crit };

  const regionFit = deduceRegionFit(st, tg);
  if (regionFit.witness) return regionFit;
  if (regionFit.steps.length > 0) return regionFit;

  const hall = deduceHall(st, tg);
  if (hall.length > 0) return { witness: null, steps: hall };

  const band = deduceBand(st, tg);
  if (band.witness) return band;
  if (band.steps.length > 0) return band;

  return null;
}

/** Difficulty ladder shared by the generator and the hint pipeline. */
const RULE_RANK: Record<string, number> = {
  propagate: 0,
  "1d-fit": 1,
  critical: 2,
  "region-fit": 3,
  hall: 4,
  "band-cover": 5,
  search: 6,
};

/** Run a single-cell search proof. Returns one step if found, else null.
 *  State is NOT mutated. */
export function findSearchStep(st: State, tg: Targets, budget = 5000): Step | null {
  const saved = st.grid.slice();
  const n = st.n;

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = idx(n, r, c);
      if (st.grid[i] !== U) continue;

      // Try crown
      const crownSt = cloneState(st);
      const crownPossible = tryPlaceCrown(crownSt, tg, r, c);
      if (!crownPossible) {
        st.grid = saved;
        return { r, c, to: E, rule: "search", reason: "No valid continuation with a crown here" };
      }
      const crownRes = searchBounded(crownSt, tg, 1, budget);
      if (!crownRes.found && !crownRes.exhausted) {
        st.grid = saved;
        return { r, c, to: E, rule: "search", reason: "Search shows no solution with crown here" };
      }

      // Try empty
      const emptySt = cloneState(st);
      emptySt.grid[i] = E;
      const emptyRes = searchBounded(emptySt, tg, 1, budget);
      if (!emptyRes.found && !emptyRes.exhausted) {
        st.grid = saved;
        return { r, c, to: K, rule: "search", reason: "Search shows no solution without crown here" };
      }
    }
  }

  st.grid = saved;
  return null;
}

/** Step collector for tracking changes through propagate(). */
export function collectPropagateChanges(st: State, before: number[]): Step[] {
  const steps: Step[] = [];
  for (let i = 0; i < st.grid.length; i++) {
    if (st.grid[i] === before[i]) continue;
    const r = Math.floor(i / st.n);
    const c = i % st.n;
    const to = st.grid[i] === K ? K : E;
    steps.push({
      r,
      c,
      to,
      rule: to === K ? "unit-forced" : "propagate",
      reason: to === K ? "Only remaining candidate" : "Eliminated by crown or completed unit",
    });
  }
  return steps;
}

export interface DeduceResult {
  solved: boolean;
  contradiction: boolean;
  steps: Step[][];
  /** Highest rule used: propagate < 1d-fit < critical < region-fit < hall < band-cover < search */
  hardest: string;
}

/** Solve by pure human deductions (no guessing).
 *  On success returns all deduction rounds.
 *  `maxMs` optionally bounds the wall time (generation uses it); exceeding the
 *  budget reports the state as unresolved rather than solved.
 */
export function solveByDeduction(st: State, tg: Targets, allowSearch = false, searchBudget = 5000, maxMs = 0): DeduceResult {
  const steps: Step[][] = [];
  let hardest = "propagate";
  const start = Date.now();

  while (maxMs === 0 || Date.now() - start < maxMs) {
    // Propagate to closure
    const before = st.grid.slice();
    const witness = propagate(st, tg);
    if (witness) return { solved: false, contradiction: true, steps, hardest };
    const propSteps = collectPropagateChanges(st, before);
    if (propSteps.length > 0) {
      steps.push(propSteps);
      if (isStateSolved(st, tg)) return { solved: true, contradiction: false, steps, hardest };
      continue;
    }

    if (isStateSolved(st, tg)) return { solved: true, contradiction: false, steps, hardest };

    // Advanced rules
    const outcome = findForcedSteps(st, tg);
    if (outcome) {
      if (outcome.witness) return { solved: false, contradiction: true, steps, hardest };
      if (outcome.steps.length > 0) {
        if (!applySteps(st, tg, outcome.steps)) return { solved: false, contradiction: true, steps, hardest };
        const rule = outcome.steps[0].rule;
        if (RULE_RANK[rule]! > RULE_RANK[hardest]!) hardest = rule;
        steps.push(outcome.steps);
        continue;
      }
    }

    // Search fallback
    if (allowSearch) {
      const searchStep = findSearchStep(st, tg, searchBudget);
      if (searchStep) {
        if (!applySteps(st, tg, [searchStep])) return { solved: false, contradiction: true, steps, hardest };
        hardest = "search";
        steps.push([searchStep]);
        continue;
      }
    }

    return { solved: false, contradiction: false, steps, hardest };
  }

  return { solved: false, contradiction: false, steps, hardest };
}

// ---------------------------------------------------------------------------
// Classic backtracking solver
// ---------------------------------------------------------------------------

export function solveAll(
  puzzle: NormalizedPuzzle,
  options: SolveOptions & { rand?: () => number } = {},
): Array<{ grid: string[][]; crowns: CrownPos[] }> {
  const limit = options.limit ?? 1;
  const budget = options.budget ?? 2_000_000;
  const { state, tg } = buildInitialState(puzzle);
  const n = state.n;

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (puzzle.initial[r][c] === EMPTY) state.grid[idx(n, r, c)] = E;
    }
  }
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (puzzle.initial[r][c] === CROWN && !tryPlaceCrown(state, tg, r, c)) return [];
    }
  }

  const ctx: SearchCtx = { tg, nodes: 0, budget, limit, out: [], exhausted: false, rand: options.rand };
  search(state, ctx);
  return ctx.out.map(stateToGrid);
}

export function solvePuzzle(raw: unknown, options: SolveOptions = {}): SolveResult {
  const { errors, puzzle } = validatePuzzleInput(raw);
  if (!puzzle) return { status: "invalid", solution: null, crowns: null, errors };
  const found = solveAll(puzzle, options);
  if (found.length === 0) {
    return { status: "unsolvable", solution: null, crowns: null, errors: ["no solution satisfies all constraints"] };
  }
  return { status: "solved", solution: found[0].grid, crowns: found[0].crowns, errors: [] };
}

// ---------------------------------------------------------------------------
// Assumption testing (for hints)
// ---------------------------------------------------------------------------

function searchPuzzle(
  puzzle: NormalizedPuzzle,
  assumption: { r: number; c: number; value: typeof EMPTY | typeof CROWN } | null,
  budget: number,
): { found: boolean; exhausted: boolean; nodes: number; witness: ContradictionWitness | null } {
  const { state, tg } = buildInitialState(puzzle);
  const n = state.n;

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (puzzle.initial[r][c] === EMPTY) state.grid[idx(n, r, c)] = E;
    }
  }
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (puzzle.initial[r][c] === CROWN && !tryPlaceCrown(state, tg, r, c)) {
        return { found: false, exhausted: false, nodes: 0, witness: null };
      }
    }
  }

  if (assumption) {
    if (assumption.value === EMPTY) {
      const i = idx(n, assumption.r, assumption.c);
      if (state.grid[i] === K) return { found: false, exhausted: false, nodes: 0, witness: null };
      if (state.grid[i] === U) state.grid[i] = E;
    } else if (!tryPlaceCrown(state, tg, assumption.r, assumption.c)) {
      const cells = [pos(assumption.r, assumption.c)];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = assumption.r + dr;
          const nc = assumption.c + dc;
          if ((dr !== 0 || dc !== 0) && nr >= 0 && nr < n && nc >= 0 && nc < n && state.grid[idx(n, nr, nc)] === K) {
            cells.push(pos(nr, nc));
          }
        }
      }
      return { found: false, exhausted: false, nodes: 0, witness: { kind: "adjacency", scope: "neighbors", cells } };
    } else {
      // A directly placed crown immediately forces its neighbourhood; capture an
      // early contradiction as a witness if one results.
      const w = propagate(state, tg);
      if (w) return { found: false, exhausted: false, nodes: 0, witness: w };
    }
  }

  const res = searchBounded(state, tg, 1, budget);
  return { found: res.found, exhausted: res.exhausted, nodes: res.nodes, witness: res.witness };
}

export function testAssumptionDetailed(
  puzzle: NormalizedPuzzle,
  r: number,
  c: number,
  value: typeof EMPTY | typeof CROWN,
  budget = 100_000,
): AssumptionDetails {
  const result = searchPuzzle(puzzle, { r, c, value }, budget);
  return {
    status: result.found ? "solved" : result.exhausted ? "unknown" : "unsatisfiable",
    nodes: result.nodes,
    witness: result.witness,
  };
}

export function testAssumption(
  puzzle: NormalizedPuzzle,
  r: number,
  c: number,
  value: typeof EMPTY | typeof CROWN,
  budget = 100_000,
): AssumptionResult {
  return testAssumptionDetailed(puzzle, r, c, value, budget).status;
}
