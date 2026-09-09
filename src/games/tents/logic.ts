/** Framework-free Tents and Trees core: board model, rules check, solver, generator. No DOM. */

export const TENTS_DEFAULT_SIZE = 8;

export type CellMark = "unknown" | "tent" | "grass";

export interface TentsLevel {
  size: number;
  /** Fixed tree positions. Tents may never sit on a tree. */
  trees: boolean[][];
  rowCounts: number[];
  colCounts: number[];
  /** Tent positions of the (unique) solution. */
  solution: boolean[][];
}

export interface TentsBoard {
  size: number;
  trees: boolean[][];
  rowCounts: number[];
  colCounts: number[];
  marks: CellMark[][];
  over: boolean;
  won: boolean;
}

export function createBoard(level: TentsLevel): TentsBoard {
  return {
    size: level.size,
    trees: level.trees.map((row) => [...row]),
    rowCounts: [...level.rowCounts],
    colCounts: [...level.colCounts],
    marks: Array.from({ length: level.size }, () =>
      Array<CellMark>(level.size).fill("unknown"),
    ),
    over: false,
    won: false,
  };
}

/** Cycle unknown -> grass -> tent -> unknown. Trees are immutable; returns false when ignored. */
export function toggleMark(board: TentsBoard, r: number, c: number): boolean {
  if (board.over) return false;
  if (r < 0 || r >= board.size || c < 0 || c >= board.size) return false;
  if (board.trees[r][c]) return false;
  const cur = board.marks[r][c];
  board.marks[r][c] = cur === "unknown" ? "grass" : cur === "grass" ? "tent" : "unknown";
  if (board.over) {
    board.over = false;
    board.won = false;
  }
  return true;
}

const ORTHO = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

function orthoTrees(trees: boolean[][], size: number, r: number, c: number): number {
  let n = 0;
  for (const [dr, dc] of ORTHO) {
    const nr = r + dr;
    const nc = c + dc;
    if (nr >= 0 && nr < size && nc >= 0 && nc < size && trees[nr][nc]) n++;
  }
  return n;
}

/** Tents placed in a row / column (for the count headers). */
export function tentsInRow(board: TentsBoard, r: number): number {
  let n = 0;
  for (let c = 0; c < board.size; c++) if (board.marks[r][c] === "tent") n++;
  return n;
}

export function tentsInCol(board: TentsBoard, c: number): number {
  let n = 0;
  for (let r = 0; r < board.size; r++) if (board.marks[r][c] === "tent") n++;
  return n;
}

export function tentsPlaced(board: TentsBoard): number {
  let n = 0;
  for (let r = 0; r < board.size; r++) {
    for (let c = 0; c < board.size; c++) {
      if (board.marks[r][c] === "tent") n++;
    }
  }
  return n;
}

export function totalTents(board: Pick<TentsBoard, "rowCounts">): number {
  return board.rowCounts.reduce((a, b) => a + b, 0);
}

/**
 * Full rules check. A win needs: row/col counts exact, no tents touching
 * (all 8 directions), tents never on trees, and an exact 1-to-1 orthogonal
 * tent-tree pairing. Sets over/won and returns won.
 */
export function checkWin(board: TentsBoard): boolean {
  const { size, trees, marks } = board;
  let ok = true;

  for (let r = 0; r < size && ok; r++) {
    if (tentsInRow(board, r) !== board.rowCounts[r]) ok = false;
  }
  for (let c = 0; c < size && ok; c++) {
    if (tentsInCol(board, c) !== board.colCounts[c]) ok = false;
  }

  // No-touch + tent/tree pairing bookkeeping.
  const tentsPerTree: number[][] = Array.from({ length: size }, () => Array(size).fill(0));
  if (ok) {
    for (let r = 0; r < size && ok; r++) {
      for (let c = 0; c < size && ok; c++) {
        if (marks[r][c] !== "tent") continue;
        if (trees[r][c]) {
          ok = false;
          break;
        }
        for (let dr = -1; dr <= 1 && ok; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = r + dr;
            const nc = c + dc;
            if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
            if (marks[nr][nc] === "tent") ok = false;
          }
        }
        let adjacent = 0;
        for (const [dr, dc] of ORTHO) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
          if (trees[nr][nc]) {
            adjacent++;
            tentsPerTree[nr][nc]++;
          }
        }
        if (adjacent !== 1) ok = false;
      }
    }
  }
  if (ok) {
    for (let r = 0; r < size && ok; r++) {
      for (let c = 0; c < size && ok; c++) {
        if (trees[r][c] && tentsPerTree[r][c] !== 1) ok = false;
      }
    }
  }

  board.over = ok;
  board.won = ok;
  return ok;
}

// ---------------------------------------------------------------------------
// Solver (used by the generator for existence + uniqueness). Backtracking
// over trees: each tree claims one orthogonal tent cell. Trees may sit
// orthogonally adjacent to each other; only tents must keep their distance.
// ---------------------------------------------------------------------------

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

function touchesPlaced(
  placed: boolean[][],
  size: number,
  r: number,
  c: number,
): boolean {
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
      if (placed[nr][nc]) return true;
    }
  }
  return false;
}

export function validateLevelData(
  trees: boolean[][],
  rowCounts: number[],
  colCounts: number[],
): string | null {
  const size = trees.length;
  if (!Number.isInteger(size) || size < 2) return `Board size must be an integer >= 2, got ${size}`;
  for (const row of trees) {
    if (row.length !== size) return "Trees grid must be square";
  }
  if (rowCounts.length !== size || colCounts.length !== size) {
    return "Row/column counts must match the board size";
  }
  const treeCount = trees.flat().filter(Boolean).length;
  const rowSum = rowCounts.reduce((a, b) => a + b, 0);
  const colSum = colCounts.reduce((a, b) => a + b, 0);
  if (rowSum !== treeCount || colSum !== treeCount) {
    return "Row/column totals must equal the tree count";
  }
  for (const n of [...rowCounts, ...colCounts]) {
    if (!Number.isInteger(n) || n < 0 || n > size) return `Count out of range: ${n}`;
  }
  return null;
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

// ---------------------------------------------------------------------------
// Generator: tents first, trees second. A random no-touch tent set is always
// solvable by construction (pair each tent with a neighboring tree cell), so
// the solver only has to confirm the row/column counts are unambiguous.
// ---------------------------------------------------------------------------

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
