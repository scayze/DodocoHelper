/** Framework-free Minesweeper core: board model + reveal/flag/win logic. No DOM. */

export const MINES_SIZE = 9;
export const MINES_COUNT = 15;

export type MineCellState = "hidden" | "revealed" | "flagged";

export interface MineBoard {
  size: number;
  mineCount: number;
  /** true where a mine sits. */
  mines: boolean[][];
  /** Precomputed adjacent mine counts (0-8). Mines hold -1. */
  adjacent: number[][];
  state: MineCellState[][];
  /** True once mines have been placed (deferred to first reveal). */
  placed: boolean;
  over: boolean;
  won: boolean;
  revealedCount: number;
}

export function createBoard(size = MINES_SIZE, mineCount = MINES_COUNT): MineBoard {
  return {
    size,
    mineCount,
    mines: Array.from({ length: size }, () => Array(size).fill(false)),
    adjacent: Array.from({ length: size }, () => Array(size).fill(0)),
    state: Array.from({ length: size }, () =>
      Array(size).fill("hidden") as MineCellState[],
    ),
    placed: false,
    over: false,
    won: false,
    revealedCount: 0,
  };
}

function neighborsOf(size: number, r: number, c: number): Array<[number, number]> {
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

/**
 * Place mines after the first reveal so the first click is always safe.
 * The clicked cell never holds a mine.
 */
export function placeMines(
  board: MineBoard,
  safeR: number,
  safeC: number,
  rand: () => number = Math.random,
): void {
  const { size, mineCount } = board;
  let placed = 0;
  let guard = 0;
  while (placed < mineCount && guard < size * size * 50) {
    guard++;
    const r = Math.floor(rand() * size);
    const c = Math.floor(rand() * size);
    if ((r === safeR && c === safeC) || board.mines[r][c]) continue;
    board.mines[r][c] = true;
    placed++;
  }
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board.mines[r][c]) {
        board.adjacent[r][c] = -1;
        continue;
      }
      let n = 0;
      for (const [nr, nc] of neighborsOf(size, r, c)) {
        if (board.mines[nr][nc]) n++;
      }
      board.adjacent[r][c] = n;
    }
  }
  board.placed = true;
}

/** Reveal a cell; flood-fills through zero-adjacent cells. Returns hit-mine.
 * Pass `rand` (e.g. the daily seed) so deferred mine placement is reproducible.
 */
export function reveal(
  board: MineBoard,
  r: number,
  c: number,
  rand: () => number = Math.random,
): boolean {
  if (board.over) return false;
  if (!board.placed) placeMines(board, r, c, rand);
  const cur = board.state[r][c];
  if (cur === "revealed" || cur === "flagged") return false;
  if (board.mines[r][c]) {
    board.state[r][c] = "revealed";
    board.over = true;
    board.won = false;
    return true;
  }
  floodReveal(board, r, c);
  checkWin(board);
  return false;
}

function floodReveal(board: MineBoard, sr: number, sc: number): void {
  const stack: Array<[number, number]> = [[sr, sc]];
  while (stack.length > 0) {
    const [r, c] = stack.pop()!;
    if (board.state[r][c] === "revealed" || board.state[r][c] === "flagged") continue;
    board.state[r][c] = "revealed";
    board.revealedCount++;
    if (board.adjacent[r][c] !== 0) continue;
    for (const [nr, nc] of neighborsOf(board.size, r, c)) {
      if (board.state[nr][nc] === "hidden") stack.push([nr, nc]);
    }
  }
}

export function toggleFlag(board: MineBoard, r: number, c: number): void {
  if (board.over) return;
  const cur = board.state[r][c];
  if (cur === "revealed") return;
  board.state[r][c] = cur === "flagged" ? "hidden" : "flagged";
}

/**
 * Classic chording: acting on an already-revealed number whose surrounding
 * flag count matches reveals all remaining hidden neighbors. Returns
 * hit-mine (true when a flag was misplaced and a mine went off).
 */
export function chord(
  board: MineBoard,
  r: number,
  c: number,
  rand: () => number = Math.random,
): boolean {
  if (board.over || board.state[r][c] !== "revealed") return false;
  const want = board.adjacent[r][c];
  if (want <= 0) return false;
  let flags = 0;
  for (const [nr, nc] of neighborsOf(board.size, r, c)) {
    if (board.state[nr][nc] === "flagged") flags++;
  }
  if (flags !== want) return false;
  let hitMine = false;
  for (const [nr, nc] of neighborsOf(board.size, r, c)) {
    if (board.state[nr][nc] === "hidden" && reveal(board, nr, nc, rand)) hitMine = true;
  }
  return hitMine;
}

function checkWin(board: MineBoard): void {
  const total = board.size * board.size;
  if (board.revealedCount === total - board.mineCount) {
    board.over = true;
    board.won = true;
  }
}

/** All mine positions, for reveal-on-loss rendering. */
export function minePositions(board: MineBoard): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let r = 0; r < board.size; r++) {
    for (let c = 0; c < board.size; c++) {
      if (board.mines[r][c]) out.push([r, c]);
    }
  }
  return out;
}
