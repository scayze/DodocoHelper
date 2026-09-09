/** Framework-free Seasons core: SameGame-style collapse puzzler. No DOM. */

export const SEASONS_SIZE = 10;

export const SEASON_TYPES = ["summer", "autumn", "spring", "winter"] as const;
export type SeasonType = (typeof SEASON_TYPES)[number];

/** A tile carries identity so the UI can animate it across moves. */
export interface Tile {
  t: SeasonType;
  id: number;
}

export type SeasonsCell = Tile | null;

export interface SeasonsBoard {
  size: number;
  /** Rows top to bottom; null is an empty slot. Columns stay bottom-justified. */
  cells: SeasonsCell[][];
  over: boolean;
  won: boolean;
}

export function createBoard(size = SEASONS_SIZE): SeasonsBoard {
  return {
    size,
    cells: Array.from({ length: size }, () => Array<SeasonsCell>(size).fill(null)),
    over: false,
    won: false,
  };
}

const DIRS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

function inBounds(size: number, r: number, c: number): boolean {
  return r >= 0 && r < size && c >= 0 && c < size;
}

/** 4-directional flood fill of the clicked cell's season type. Empty cells yield []. */
export function findRegion(
  board: SeasonsBoard,
  r: number,
  c: number,
): Array<[number, number]> {
  if (!inBounds(board.size, r, c)) return [];
  const tile = board.cells[r][c];
  if (tile === null) return [];
  const type = tile.t;
  const region: Array<[number, number]> = [];
  const seen = new Set<number>([r * board.size + c]);
  const stack: Array<[number, number]> = [[r, c]];
  while (stack.length > 0) {
    const [cr, cc] = stack.pop()!;
    region.push([cr, cc]);
    for (const [dr, dc] of DIRS) {
      const nr = cr + dr;
      const nc = cc + dc;
      const key = nr * board.size + nc;
      if (!inBounds(board.size, nr, nc) || seen.has(key)) continue;
      if (board.cells[nr][nc]?.t !== type) continue;
      seen.add(key);
      stack.push([nr, nc]);
    }
  }
  return region;
}

/**
 * Remove a region (illegal when smaller than 2 cells), then let squares
 * above fall down and collapse emptied columns to the right.
 */
export function removeRegion(
  board: SeasonsBoard,
  region: Array<[number, number]>,
): boolean {
  if (board.over || region.length < 2) return false;
  for (const [r, c] of region) board.cells[r][c] = null;
  applyGravity(board);
  collapseColumns(board);
  if (remainingCount(board) === 0) {
    board.over = true;
    board.won = true;
  } else if (!hasAvailableMove(board)) {
    // Tiles remain but nothing is clickable: the level is stuck (lost).
    board.over = true;
    board.won = false;
  }
  return true;
}

/** True when at least one clickable group (region of size >= 2) exists. */
export function hasAvailableMove(board: SeasonsBoard): boolean {
  const { size, cells } = board;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const t = cells[r][c]?.t;
      if (t === undefined) continue;
      // Any region of size >= 2 contains an orthogonally adjacent equal pair.
      if (c + 1 < size && cells[r][c + 1]?.t === t) return true;
      if (r + 1 < size && cells[r + 1][c]?.t === t) return true;
    }
  }
  return false;
}

/** Bottom-justify every column in place. */
function applyGravity(board: SeasonsBoard): void {
  const { size, cells } = board;
  for (let c = 0; c < size; c++) {
    let write = size - 1;
    for (let r = size - 1; r >= 0; r--) {
      const cell = cells[r][c];
      if (cell !== null) {
        cells[write][c] = cell;
        if (write !== r) cells[r][c] = null;
        write--;
      }
    }
  }
}

/** Slide surviving columns right (order preserved); empties pad the left. */
function collapseColumns(board: SeasonsBoard): void {
  const { size, cells } = board;
  const kept: SeasonsCell[][] = [];
  for (let c = 0; c < size; c++) {
    let empty = true;
    for (let r = 0; r < size; r++) {
      if (cells[r][c] !== null) {
        empty = false;
        break;
      }
    }
    if (!empty) kept.push(cells.map((row) => row[c]));
  }
  const pad = size - kept.length;
  for (let c = 0; c < size; c++) {
    for (let r = 0; r < size; r++) {
      cells[r][c] = c < pad ? null : kept[c - pad][r];
    }
  }
}

export function remainingCount(board: SeasonsBoard): number {
  let n = 0;
  for (const row of board.cells) {
    for (const cell of row) {
      if (cell !== null) n++;
    }
  }
  return n;
}

export function isCleared(board: SeasonsBoard): boolean {
  return remainingCount(board) === 0;
}
