/** Framework-free Tents and Trees core: board model and rules check. No DOM. */

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

export const ORTHO = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

export function orthoTrees(trees: boolean[][], size: number, r: number, c: number): number {
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

// Solver and generator live in ./solver.ts and ./generator.ts.
export function touchesPlaced(
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
