/** Logic solver for Minesweeper no-guess verification + opening search. No DOM. */

export interface Opening {
  r: number;
  c: number;
}

export interface SolverCaps {
  /** Frontier cells above this skip exact enumeration (default 22). */
  maxFrontier?: number;
  /** Backtracking node budget per deduce call (default 50_000). */
  maxNodes?: number;
  /** Solutions enumerated per deduce call (default 2000). */
  maxSolutions?: number;
}

const DEFAULTS = { maxFrontier: 22, maxNodes: 50_000, maxSolutions: 2000 };

/** 0 = hidden, 1 = revealed, 2 = flagged (generation-time view). */
export type Vis = 0 | 1 | 2;

export function neighborsOf(size: number, r: number, c: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < size && nc >= 0 && nc < size) out.push([nr, nc]);
    }
  }
  return out;
}

export function computeAdjacent(mines: boolean[][], size: number): number[][] {
  const adj: number[][] = Array.from({ length: size }, () => Array(size).fill(0));
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (mines[r][c]) {
        adj[r][c] = -1;
        continue;
      }
      let n = 0;
      for (const [nr, nc] of neighborsOf(size, r, c)) {
        if (mines[nr][nc]) n++;
      }
      adj[r][c] = n;
    }
  }
  return adj;
}

/** Flood reveal from (sr,sc) into vis; returns newly revealed count. */
function floodInto(
  vis: Vis[][],
  adjacent: number[][],
  size: number,
  sr: number,
  sc: number,
): number {
  if (vis[sr][sc] !== 0) return 0;
  let gained = 0;
  const stack: Array<[number, number]> = [[sr, sc]];
  while (stack.length > 0) {
    const [r, c] = stack.pop()!;
    if (vis[r][c] !== 0) continue;
    vis[r][c] = 1;
    gained++;
    if (adjacent[r][c] !== 0) continue;
    for (const [nr, nc] of neighborsOf(size, r, c)) {
      if (vis[nr][nc] === 0) stack.push([nr, nc]);
    }
  }
  return gained;
}

interface Constraint {
  cells: number[];
  need: number;
}

/** Collect one constraint per revealed number bordering hidden cells. */
function collectConstraints(
  vis: Vis[][],
  adjacent: number[][],
  size: number,
): { constraints: Constraint[]; indexOf: Map<string, number>; frontier: Array<[number, number]> } {
  const indexOf = new Map<string, number>();
  const frontier: Array<[number, number]> = [];
  const key = (r: number, c: number): string => `${r},${c}`;
  const ensure = (r: number, c: number): number => {
    const k = key(r, c);
    let i = indexOf.get(k);
    if (i === undefined) {
      i = frontier.length;
      indexOf.set(k, i);
      frontier.push([r, c]);
    }
    return i;
  };
  const constraints: Constraint[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (vis[r][c] !== 1 || adjacent[r][c] <= 0) continue;
      let flags = 0;
      const hidden: number[] = [];
      for (const [nr, nc] of neighborsOf(size, r, c)) {
        if (vis[nr][nc] === 2) flags++;
        else if (vis[nr][nc] === 0) hidden.push(ensure(nr, nc));
      }
      if (hidden.length === 0) continue;
      constraints.push({ cells: hidden, need: adjacent[r][c] - flags });
    }
  }
  return { constraints, indexOf, frontier };
}

/** Singles + subset deduction. Returns definite safe/mine frontier indices. */
function deduceSimple(
  constraints: Constraint[],
): { safe: Set<number>; mines: Set<number> } {
  const safe = new Set<number>();
  const mines = new Set<number>();
  let changed = true;
  const knownSafe = new Set<number>();
  const knownMine = new Set<number>();
  while (changed) {
    changed = false;
    const consider = (cells: number[], need: number): void => {
      const open = cells.filter((i) => !knownSafe.has(i) && !knownMine.has(i));
      const needAdj = need - cells.filter((i) => knownMine.has(i)).length;
      if (open.length === 0) return;
      if (needAdj === 0) {
        for (const i of open) {
          if (!knownSafe.has(i)) {
            knownSafe.add(i);
            changed = true;
          }
        }
      } else if (needAdj === open.length) {
        for (const i of open) {
          if (!knownMine.has(i)) {
            knownMine.add(i);
            changed = true;
          }
        }
      }
    };
    for (const con of constraints) consider(con.cells, con.need);
    // Subset rule: A ⊂ B => B\A needs (needB - needA).
    for (let a = 0; a < constraints.length; a++) {
      for (let b = 0; b < constraints.length; b++) {
        if (a === b) continue;
        const A = constraints[a];
        const B = constraints[b];
        if (A.cells.length === 0 || A.cells.length >= B.cells.length) continue;
        const setB = new Set(B.cells);
        if (!A.cells.every((i) => setB.has(i))) continue;
        const diff = B.cells.filter((i) => !A.cells.includes(i));
        if (diff.length === 0) continue;
        consider(diff, B.need - A.need);
      }
    }
  }
  for (const i of knownSafe) safe.add(i);
  for (const i of knownMine) mines.add(i);
  return { safe, mines };
}

interface EnumResult {
  safe: number[];
  mines: number[];
}

/** Exact enumeration over the frontier; finds cells decided in ALL solutions. */
function deduceEnum(
  constraints: Constraint[],
  frontierSize: number,
  caps: Required<SolverCaps>,
): EnumResult {
  if (frontierSize === 0 || frontierSize > caps.maxFrontier) return { safe: [], mines: [] };
  // Order cells by occurrence for better pruning.
  const order = Array.from({ length: frontierSize }, (_, i) => i).sort((a, b) => {
    const ca = constraints.filter((c) => c.cells.includes(a)).length;
    const cb = constraints.filter((c) => c.cells.includes(b)).length;
    return cb - ca;
  });
  const posOf = new Array<number>(frontierSize);
  order.forEach((orig, pos) => {
    posOf[orig] = pos;
  });
  const remapped: Constraint[] = constraints.map((c) => ({
    cells: c.cells.map((i) => posOf[i]).sort((x, y) => x - y),
    need: c.need,
  }));
  // Quick sanity: impossible needs mean no solutions; caller treats as stall.
  for (const c of remapped) {
    if (c.need < 0 || c.need > c.cells.length) return { safe: [], mines: [] };
  }
  const assign = new Array<number>(frontierSize).fill(-1);
  const mineCount = new Array<number>(frontierSize).fill(0);
  let solutions = 0;
  let nodes = 0;

  const consistent = (): boolean => {
    for (const c of remapped) {
      let placed = 0;
      let open = 0;
      for (const i of c.cells) {
        const v = assign[i];
        if (v === 1) placed++;
        else if (v === -1) open++;
      }
      if (c.need < placed || c.need > placed + open) return false;
    }
    return true;
  };

  const bt = (pos: number): boolean => {
    if (solutions >= caps.maxSolutions || nodes >= caps.maxNodes) return false;
    if (pos === frontierSize) {
      for (const c of remapped) {
        let s = 0;
        for (const i of c.cells) s += assign[i];
        if (s !== c.need) return true;
      }
      solutions++;
      for (let i = 0; i < frontierSize; i++) {
        if (assign[i] === 1) mineCount[order[i]]++;
      }
      return true;
    }
    nodes++;
    assign[pos] = 0;
    if (consistent()) bt(pos + 1);
    if (solutions >= caps.maxSolutions || nodes >= caps.maxNodes) {
      assign[pos] = -1;
      return false;
    }
    assign[pos] = 1;
    if (consistent()) bt(pos + 1);
    assign[pos] = -1;
    return true;
  };
  bt(0);
  if (solutions === 0) return { safe: [], mines: [] };
  const safe: number[] = [];
  const mines: number[] = [];
  for (let i = 0; i < frontierSize; i++) {
    if (mineCount[i] === 0) safe.push(i);
    else if (mineCount[i] === solutions) mines.push(i);
  }
  return { safe, mines };
}

function countRevealed(vis: Vis[][], size: number): number {
  let n = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (vis[r][c] === 1) n++;
    }
  }
  return n;
}

/**
 * True when the board is fully clearable by logic alone starting from the
 * given opening cell (no guessing): flood, then iterative singles → subset →
 * exact frontier enumeration until win or stall.
 */
export function isLogicSolvableFrom(
  mines: boolean[][],
  size: number,
  startR: number,
  startC: number,
  caps: SolverCaps = {},
): boolean {
  const full: Required<SolverCaps> = { ...DEFAULTS, ...caps };
  if (mines[startR][startC]) return false;
  const adjacent = computeAdjacent(mines, size);
  const totalSafe = size * size - mines.flat().filter(Boolean).length;
  const vis: Vis[][] = Array.from({ length: size }, () => Array(size).fill(0) as Vis[]);
  floodInto(vis, adjacent, size, startR, startC);
  for (let guard = 0; guard < size * size * 2; guard++) {
    if (countRevealed(vis, size) === totalSafe) return true;
    const { constraints, frontier } = collectConstraints(vis, adjacent, size);
    if (frontier.length === 0) return countRevealed(vis, size) === totalSafe;
    const simple = deduceSimple(constraints);
    let safeIdx = [...simple.safe];
    let mineIdx = [...simple.mines];
    if (safeIdx.length === 0 && mineIdx.length === 0) {
      const e = deduceEnum(constraints, frontier.length, full);
      safeIdx = e.safe;
      mineIdx = e.mines;
    }
    if (safeIdx.length === 0 && mineIdx.length === 0) return false;
    for (const i of mineIdx) {
      const [r, c] = frontier[i];
      if (vis[r][c] === 0) vis[r][c] = 2;
    }
    let gained = 0;
    for (const i of safeIdx) {
      const [r, c] = frontier[i];
      gained += floodInto(vis, adjacent, size, r, c);
    }
    if (gained === 0 && mineIdx.length === 0) return false;
    // Flag-only progress still helps: loop back for fresh singles.
    if (gained === 0 && mineIdx.length > 0) continue;
  }
  return false;
}

/** Flood size of every cell (for ranking openings); mines get -1. */
export function floodSizes(
  mines: boolean[][],
  adjacent: number[][],
  size: number,
): number[][] {
  const out: number[][] = Array.from({ length: size }, () => Array(size).fill(-1));
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (mines[r][c]) continue;
      const vis: Vis[][] = Array.from({ length: size }, () => Array(size).fill(0) as Vis[]);
      out[r][c] = floodInto(vis, adjacent, size, r, c);
    }
  }
  return out;
}

/**
 * Best guaranteed opening: among zero-cells, the largest flood that is fully
 * logic-solvable. Deterministic tie-break (flood desc, row, col). Null when
 * no zero-cell yields a no-guess solution.
 */
export function findBestOpening(
  mines: boolean[][],
  size: number,
  caps: SolverCaps = {},
): Opening | null {
  const adjacent = computeAdjacent(mines, size);
  const sizes = floodSizes(mines, adjacent, size);
  const candidates: Array<Opening & { flood: number }> = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (mines[r][c] || adjacent[r][c] !== 0) continue;
      candidates.push({ r, c, flood: sizes[r][c] });
    }
  }
  candidates.sort((a, b) => b.flood - a.flood || a.r - b.r || a.c - b.c);
  for (const cand of candidates) {
    if (isLogicSolvableFrom(mines, size, cand.r, cand.c, caps)) return { r: cand.r, c: cand.c };
  }
  return null;
}
