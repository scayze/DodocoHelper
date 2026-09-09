/** Framework-free Wardrobe core: SameGame-style collapse puzzler. No DOM. */

export const WARDROBE_SIZE = 10;

export const CLOTH_TYPES = ["shirt", "shoe", "pant", "bag"] as const;
export type ClothType = (typeof CLOTH_TYPES)[number];

/** A tile carries identity so the UI can animate it across moves. */
export interface Tile {
  t: ClothType;
  id: number;
}

export type WardrobeCell = Tile | null;

export interface WardrobeBoard {
  size: number;
  /** Rows top to bottom; null is an empty slot. Columns stay bottom-justified. */
  cells: WardrobeCell[][];
  over: boolean;
  won: boolean;
}

export function createBoard(size = WARDROBE_SIZE): WardrobeBoard {
  return {
    size,
    cells: Array.from({ length: size }, () => Array<WardrobeCell>(size).fill(null)),
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

/** 4-directional flood fill of the clicked cell's clothing type. Empty cells yield []. */
export function findRegion(
  board: WardrobeBoard,
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
  board: WardrobeBoard,
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
export function hasAvailableMove(board: WardrobeBoard): boolean {
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
function applyGravity(board: WardrobeBoard): void {
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
function collapseColumns(board: WardrobeBoard): void {
  const { size, cells } = board;
  const kept: WardrobeCell[][] = [];
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

export function remainingCount(board: WardrobeBoard): number {
  let n = 0;
  for (const row of board.cells) {
    for (const cell of row) {
      if (cell !== null) n++;
    }
  }
  return n;
}

export function isCleared(board: WardrobeBoard): boolean {
  return remainingCount(board) === 0;
}

// ---------------------------------------------------------------------------
// Level generator: reverse play. Construction runs a game backwards from a
// solved state, so reading the insertions back-to-front is a legal clear
// order and every level is solvable by construction. No solver is needed.
// ---------------------------------------------------------------------------

export interface GeneratedLevel {
  cells: WardrobeCell[][];
  /**
   * Tile ids per inserted cluster in clear order: removing each group's
   * region in order empties the board. Exposed for tests.
   */
  solution: number[][];
}

/** Count same-type connected regions (4-directional). */
export function countRegions(cells: WardrobeCell[][], size: number): number {
  const seen = new Set<number>();
  let regions = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const tile = cells[r][c];
      const key = r * size + c;
      if (tile === null || seen.has(key)) continue;
      regions++;
      const stack: Array<[number, number]> = [[r, c]];
      seen.add(key);
      while (stack.length > 0) {
        const [cr, cc] = stack.pop()!;
        for (const [dr, dc] of DIRS) {
          const nr = cr + dr;
          const nc = cc + dc;
          const nkey = nr * size + nc;
          if (!inBounds(size, nr, nc) || seen.has(nkey)) continue;
          if (cells[nr][nc]?.t !== tile.t) continue;
          seen.add(nkey);
          stack.push([nr, nc]);
        }
      }
    }
  }
  return regions;
}

/** Count singleton tiles (no equal orthogonal neighbor). */
export function countSingles(cells: WardrobeCell[][], size: number): number {
  let singles = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const t = cells[r][c]?.t;
      if (t === undefined) continue;
      let single = true;
      for (const [dr, dc] of DIRS) {
        const nr = r + dr;
        const nc = c + dc;
        if (inBounds(size, nr, nc) && cells[nr][nc]?.t === t) {
          single = false;
          break;
        }
      }
      if (single) singles++;
    }
  }
  return singles;
}

/**
 * Replay a generated solution: for each group in clear order, remove the
 * region around the first tile of that group still on the board (groups
 * already swept away by an earlier merged removal are skipped). Returns
 * true only for a full clear through legal moves.
 */
export function verifySolution(
  cells: WardrobeCell[][],
  solution: number[][],
  size: number,
): boolean {
  const board: WardrobeBoard = {
    size,
    cells: cells.map((row) => [...row]),
    over: false,
    won: false,
  };
  for (const group of solution) {
    const ids = new Set(group);
    let anchor: [number, number] | null = null;
    for (let r = 0; r < size && !anchor; r++) {
      for (let c = 0; c < size; c++) {
        if (ids.has(board.cells[r][c]?.id ?? -1)) {
          anchor = [r, c];
          break;
        }
      }
    }
    if (!anchor) continue;
    const region = findRegion(board, anchor[0], anchor[1]);
    if (region.length < 2) return false;
    // Bypass the stuck flag: every intermediate state of a valid solution
    // keeps a move; only the final state may legitimately end the game.
    board.over = false;
    if (!removeRegion(board, region)) return false;
    board.over = false;
  }
  return remainingCount(board) === 0;
}

function randInt(rand: () => number, n: number): number {
  return Math.floor(rand() * n);
}

/** Random type outside the ban set; null when every type is banned. */
function pickFreshType(
  banned: Set<ClothType>,
  rand: () => number,
): ClothType | null {
  const free = CLOTH_TYPES.filter((t) => !banned.has(t));
  if (free.length === 0) return null;
  return free[randInt(rand, free.length)];
}

/** Column height; columns stay bottom-justified, so counting up suffices. */
function columnHeight(
  cells: WardrobeCell[][],
  size: number,
  c: number,
): number {
  let h = 0;
  for (let r = size - 1; r >= 0 && cells[r][c] !== null; r--) h++;
  return h;
}

/**
 * Occupied column count; the board stays right-justified, so these are the
 * rightmost columns and every one of them is bottom-justified.
 */
function columnsUsed(cells: WardrobeCell[][], size: number): number {
  let used = 0;
  for (let c = size - 1; c >= 0 && cells[size - 1][c] !== null; c--) used++;
  return used;
}

function isFull(cells: WardrobeCell[][], size: number): boolean {
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (cells[r][c] === null) return false;
    }
  }
  return true;
}

interface ReverseBuilder {
  cells: WardrobeCell[][];
  /** Tile ids per insertion, oldest first; reversed at the end for clear order. */
  groups: number[][];
  nextId: number;
}

/** Stamp one monochromatic cluster; it clears as a single future move. */
function stamp(
  builder: ReverseBuilder,
  shape: Array<[number, number]>,
  type: ClothType,
): void {
  const ids: number[] = [];
  for (const [r, c] of shape) {
    const id = builder.nextId++;
    builder.cells[r][c] = { t: type, id };
    ids.push(id);
  }
  builder.groups.push(ids);
}

/** Add the side-neighbor types touching (r, c); empties contribute nothing. */
function banSides(
  builder: ReverseBuilder,
  size: number,
  r: number,
  c: number,
  banned: Set<ClothType>,
): void {
  const left = c > 0 ? builder.cells[r][c - 1]?.t : undefined;
  const right = c + 1 < size ? builder.cells[r][c + 1]?.t : undefined;
  if (left !== undefined) banned.add(left);
  if (right !== undefined) banned.add(right);
}

/** Run lengths that never strand a single cell: the remainder is 0 or >= 2. */
function fitLens(space: number, maxLen: number): number[] {
  const lens: number[] = [];
  for (let len = 2; len <= Math.min(maxLen, space); len++) {
    if (space - len === 0 || space - len >= 2) lens.push(len);
  }
  return lens;
}

/**
 * Split step (reverse gravity): lift the upper part of a column and fill the
 * gap with a fresh cluster. Forward, the gap clears first and the split run
 * falls back together, so its fragments read as singletons until then.
 */
function splitStep(
  builder: ReverseBuilder,
  size: number,
  rand: () => number,
): boolean {
  const { cells } = builder;
  const feasible: number[] = [];
  for (let c = 0; c < size; c++) {
    const h = columnHeight(cells, size, c);
    if (h >= 2 && h <= size - 2) feasible.push(c);
  }
  for (let attempt = 0; attempt < 30 && feasible.length > 0; attempt++) {
    const c = feasible[randInt(rand, feasible.length)];
    const h = columnHeight(cells, size, c);
    const top = size - h;
    // Cut between r and r+1; prefer cutting through a same-type run so the
    // split fragments a cluster instead of just stretching a seam.
    const cuts: number[] = [];
    const runCuts: number[] = [];
    for (let r = top; r < size - 1; r++) {
      cuts.push(r);
      if (cells[r][c]!.t === cells[r + 1][c]!.t) runCuts.push(r);
    }
    const pool = runCuts.length > 0 ? runCuts : cuts;
    const r = pool[randInt(rand, pool.length)];
    const gaps = fitLens(size - h, 3);
    if (gaps.length === 0) continue;
    const gap = gaps[randInt(rand, gaps.length)];
    const banned = new Set<ClothType>([cells[r][c]!.t, cells[r + 1][c]!.t]);
    for (let g = r - gap + 1; g <= r; g++) banSides(builder, size, g, c, banned);
    const type = pickFreshType(banned, rand);
    if (type === null) continue;
    // Lift rows [top..r] up by gap; ascending, so no source is overwritten.
    for (let rr = top; rr <= r; rr++) cells[rr - gap][c] = cells[rr][c];
    const shape: Array<[number, number]> = [];
    for (let g = r - gap + 1; g <= r; g++) shape.push([g, c]);
    stamp(builder, shape, type);
    return true;
  }
  return false;
}

/**
 * Beam step (horizontal split): lift the segments above a cut row across a
 * span of 2-3 adjacent columns and fill the k x w gap with one fresh
 * cluster. Gravity is per-column, so forward the beam clears as a single
 * move and every column's run falls back together exactly.
 */
function beamStep(
  builder: ReverseBuilder,
  size: number,
  rand: () => number,
  wideBias = 0.25,
): boolean {
  const { cells } = builder;
  if (size < 2) return false;
  // Only fully-occupied spans with headroom can take a beam; narrow spans
  // ban fewer types, so prefer w = 2.
  const narrow: Array<{ c0: number; w: number; room: number }> = [];
  const wide: Array<{ c0: number; w: number; room: number }> = [];
  for (let w = 2; w <= Math.min(3, size); w++) {
    for (let c0 = 0; c0 + w <= size; c0++) {
      let room = size;
      let occupied = true;
      for (let c = c0; c < c0 + w; c++) {
        const h = columnHeight(cells, size, c);
        if (h < 2) {
          occupied = false;
          break;
        }
        room = Math.min(room, size - h);
      }
      if (!occupied || fitLens(room, 3).length === 0) continue;
      (w === 2 ? narrow : wide).push({ c0, w, room });
    }
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    const spans =
      narrow.length > 0 && (wide.length === 0 || rand() < 1 - wideBias)
        ? narrow
        : wide;
    if (spans.length === 0) return false;
    const { c0, w, room } = spans[randInt(rand, spans.length)];
    const gaps = fitLens(room, 3);
    // Cut rows are those covered by every spanned column.
    const lo = Math.max(
      ...Array.from({ length: w }, (_, k) => size - columnHeight(cells, size, c0 + k)),
    );
    const cuts: number[] = [];
    const runCuts: number[] = [];
    for (let r = lo; r < size - 1; r++) {
      cuts.push(r);
      let run = true;
      for (let c = c0; c < c0 + w; c++) {
        if (cells[r][c]!.t !== cells[r + 1][c]!.t) {
          run = false;
          break;
        }
      }
      if (run) runCuts.push(r);
    }
    if (cuts.length === 0) continue;
    const pool = runCuts.length > 0 ? runCuts : cuts;
    // Sample a few (cut, gap) combos and keep the one banning the fewest
    // types; striped neighbors often cover everything, so blind picks fail.
    let pick: { r: number; gap: number; banned: Set<ClothType> } | null = null;
    for (let s = 0; s < 6; s++) {
      const r = pool[randInt(rand, pool.length)];
      const gap = gaps[randInt(rand, gaps.length)];
      if (r - gap + 1 < lo) continue;
      const banned = new Set<ClothType>();
      for (let c = c0; c < c0 + w; c++) {
        banned.add(cells[r][c]!.t);
        banned.add(cells[r + 1][c]!.t);
      }
      for (let g = r - gap + 1; g <= r; g++) {
        banSides(builder, size, g, c0, banned);
        banSides(builder, size, g, c0 + w - 1, banned);
      }
      if (pick === null || banned.size < pick.banned.size) {
        pick = { r, gap, banned };
        if (banned.size <= 2) break;
      }
    }
    if (pick === null) continue;
    const type = pickFreshType(pick.banned, rand);
    if (type === null) continue;
    const { r, gap } = pick;
    for (let c = c0; c < c0 + w; c++) {
      const cTop = size - columnHeight(cells, size, c);
      for (let rr = cTop; rr <= r; rr++) cells[rr - gap][c] = cells[rr][c];
    }
    const shape: Array<[number, number]> = [];
    for (let g = r - gap + 1; g <= r; g++) {
      for (let c = c0; c < c0 + w; c++) shape.push([g, c]);
    }
    stamp(builder, shape, type);
    return true;
  }
  return false;
}

/**
 * Stack step: pile a fresh run on top of a non-full column. Forward, it
 * clears without disturbing the tiles below it.
 */
function stackStep(
  builder: ReverseBuilder,
  size: number,
  rand: () => number,
): boolean {
  const { cells } = builder;
  const feasible: number[] = [];
  for (let c = 0; c < size; c++) {
    const h = columnHeight(cells, size, c);
    if (h >= 1 && h <= size - 2) feasible.push(c);
  }
  for (let attempt = 0; attempt < 30 && feasible.length > 0; attempt++) {
    const c = feasible[randInt(rand, feasible.length)];
    const h = columnHeight(cells, size, c);
    // Capped at 3 (not 4) so stacks stay small and boundaries multiply.
    const lens = fitLens(size - h, 2);
    if (lens.length === 0) continue;
    // Level the skyline: matching a neighbor's height creates the
    // equal-height pairs lintels and beams build on.
    const neighbors: number[] = [];
    if (c > 0) neighbors.push(columnHeight(cells, size, c - 1));
    if (c + 1 < size) neighbors.push(columnHeight(cells, size, c + 1));
    const level = lens.filter(
      (len) => h + len === neighbors[0] || h + len === neighbors[1],
    );
    const pool = level.length > 0 && rand() < 0.5 ? level : lens;
    const len = pool[randInt(rand, pool.length)];
    const top = size - h - len;
    const banned = new Set<ClothType>([cells[size - h][c]!.t]);
    for (let r = top; r < size - h; r++) banSides(builder, size, r, c, banned);
    const type = pickFreshType(banned, rand);
    if (type === null) continue;
    const shape: Array<[number, number]> = [];
    for (let r = top; r < size - h; r++) shape.push([r, c]);
    stamp(builder, shape, type);
    return true;
  }
  return false;
}

/**
 * Lintel step: lay a 1x2 horizontal run across the tops of two adjacent
 * equal-height columns. Forward it lifts off without disturbing the tiles
 * below it.
 */
function lintelStep(
  builder: ReverseBuilder,
  size: number,
  rand: () => number,
): boolean {
  const { cells } = builder;
  const pairs: number[] = [];
  for (let c = 0; c + 1 < size; c++) {
    const h = columnHeight(cells, size, c);
    if (h < 1 || columnHeight(cells, size, c + 1) !== h) continue;
    const space = size - h;
    if (space === 1 || space >= 3) pairs.push(c);
  }
  for (let attempt = 0; attempt < 12 && pairs.length > 0; attempt++) {
    const c = pairs[randInt(rand, pairs.length)];
    const h = columnHeight(cells, size, c);
    const r = size - h - 1;
    const banned = new Set<ClothType>([cells[r + 1][c]!.t, cells[r + 1][c + 1]!.t]);
    banSides(builder, size, r, c, banned);
    banSides(builder, size, r, c + 1, banned);
    const type = pickFreshType(banned, rand);
    if (type === null) continue;
    stamp(builder, [[r, c], [r, c + 1]], type);
    return true;
  }
  return false;
}

/**
 * Open two fresh columns at once with one 2-wide block. Forward, the block
 * clears as a single move and the right suffix stays in place. Pair blocks
 * birth horizontal bonds that single-column opens never create.
 */
function pairColumnStep(
  builder: ReverseBuilder,
  size: number,
  rand: () => number,
): boolean {
  const used = columnsUsed(builder.cells, size);
  if (used + 2 > size) return false;
  const c = size - used - 2;
  // Small blocks: more boundaries chop into singletons, fewer slabs.
  const lens = fitLens(size, 3);
  for (let attempt = 0; attempt < 8 && lens.length > 0; attempt++) {
    const len = lens[randInt(rand, lens.length)];
    // Left of the pair is empty and nothing sits above or below; only the
    // occupied right neighbor constrains the type.
    const banned = new Set<ClothType>();
    for (let r = size - len; r < size; r++) banSides(builder, size, r, c + 1, banned);
    const type = pickFreshType(banned, rand);
    if (type === null) continue;
    const shape: Array<[number, number]> = [];
    for (let r = size - len; r < size; r++) shape.push([r, c], [r, c + 1]);
    stamp(builder, shape, type);
    return true;
  }
  return false;
}

/** Open a fresh bottom-justified column to the left of the board. Forward, it clears in place. */
function newColumnStep(
  builder: ReverseBuilder,
  size: number,
  rand: () => number,
): boolean {
  const used = columnsUsed(builder.cells, size);
  if (used >= size) return false;
  const c = size - used - 1;
  // Capped at 3 (not 4) so fresh columns stay small and boundaries multiply.
  const lens = fitLens(size, 2);
  // Open at the right neighbor's height when possible: a level skyline
  // grows more lintel pairs and beam spans.
  const rightH = columnHeight(builder.cells, size, c + 1);
  const match = lens.includes(rightH) ? [rightH] : [];
  for (let attempt = 0; attempt < 8 && lens.length > 0; attempt++) {
    const pool = match.length > 0 && rand() < 0.5 ? match : lens;
    const len = pool[randInt(rand, pool.length)];
    const banned = new Set<ClothType>();
    for (let r = size - len; r < size; r++) banSides(builder, size, r, c, banned);
    const type = pickFreshType(banned, rand);
    if (type === null) continue;
    const shape: Array<[number, number]> = [];
    for (let r = size - len; r < size; r++) shape.push([r, c]);
    stamp(builder, shape, type);
    return true;
  }
  return false;
}

function expandStep(
  builder: ReverseBuilder,
  size: number,
  rand: () => number,
): boolean {
  let canStack = false;
  for (let c = 0; c < size; c++) {
    const h = columnHeight(builder.cells, size, c);
    if (h >= 1 && h <= size - 2) {
      canStack = true;
      break;
    }
  }
  const used = columnsUsed(builder.cells, size);
  const canPair = used + 2 <= size;
  const canNew = used < size;
  // Pairs birth horizontal bonds, so prefer them for fresh columns.
  if (canPair && rand() < 0.6) {
    return (
      pairColumnStep(builder, size, rand) ||
      newColumnStep(builder, size, rand) ||
      stackStep(builder, size, rand)
    );
  }
  if (canNew && (!canStack || rand() < 0.5)) {
    return newColumnStep(builder, size, rand) || stackStep(builder, size, rand);
  }
  return (
    stackStep(builder, size, rand) ||
    pairColumnStep(builder, size, rand) ||
    newColumnStep(builder, size, rand)
  );
}

function tryReverseBuild(
  size: number,
  rand: () => number,
): GeneratedLevel | null {
  const cells: WardrobeCell[][] = Array.from({ length: size }, () =>
    Array<WardrobeCell>(size).fill(null),
  );
  const builder: ReverseBuilder = { cells, groups: [], nextId: 1 };
  // Seed: a single cluster in the bottom-right corner. Everything grows here.
  const seedOptions = fitLens(size, 3);
  const seedLen = seedOptions[randInt(rand, seedOptions.length)];
  const seedShape: Array<[number, number]> = [];
  for (let r = size - seedLen; r < size; r++) seedShape.push([r, size - 1]);
  stamp(builder, seedShape, CLOTH_TYPES[randInt(rand, CLOTH_TYPES.length)]);
  // Every step fills at least 2 empty slots and never empties one, so this
  // always terminates; a null return just retries the whole build.
  const total = size * size;
  for (let guard = total; guard > 0; guard--) {
    if (isFull(cells, size)) {
      return { cells, solution: builder.groups.reverse() };
    }
    // Beams placed late survive: later vertical splits would chop them into
    // 1-wide strips again, so their share grows with the fill fraction
    // (early game grows the board, late game decorates it). Past 60% the
    // vertical split drops out of the chain entirely, leaving only ops that
    // never disturb existing tiles (stacks/new columns pile on top or to
    // the side); it stays on as a last resort so a stuck board retries
    // instead of failing outright.
    const fill = (builder.nextId - 1) / total;
    const pBeam = 0.15 + 0.6 * fill;
    const roll = rand();
    // Early splits fragment pair blocks into singletons (gracefully: pairs
    // survive below each cut), so keep their share up while growing.
    const pSplit = 5.8 - 0.1 * fill;
    const late = fill >= 0.5;
    const beamLate = (): boolean => beamStep(builder, size, rand, 0.5);
    const ok = late
      ? beamLate() ||
        lintelStep(builder, size, rand) ||
        expandStep(builder, size, rand) ||
        splitStep(builder, size, rand)
      : roll < pBeam
        ? beamStep(builder, size, rand) ||
          lintelStep(builder, size, rand) ||
          splitStep(builder, size, rand) ||
          expandStep(builder, size, rand)
        : roll < pBeam + pSplit
          ? splitStep(builder, size, rand) ||
            beamStep(builder, size, rand) ||
            expandStep(builder, size, rand) ||
            lintelStep(builder, size, rand)
          : expandStep(builder, size, rand) ||
            splitStep(builder, size, rand) ||
            beamStep(builder, size, rand) ||
            lintelStep(builder, size, rand);
    if (!ok) return null;
  }
  return null;
}

/**
 * Generate a level that always clears fully. Each step preserves two
 * invariants: the board stays bottom/right-justified with no holes, and no
 * two orthogonal neighbors share a type. So every inserted cluster is its
 * own region, and removing the solution groups in order undoes the build
 * exactly: gap clearances let split runs and beams fall back together,
 * stacks and lintels lift off, and left columns clear in place. Horizontal
 * ops (beams, lintels, pair opens) run alongside the vertical ones so fresh
 * boards mix bars in both directions instead of striping vertically.
 */
export function generateLevel(
  size = WARDROBE_SIZE,
  rand: () => number = Math.random,
): GeneratedLevel {
  if (!Number.isInteger(size) || size < 2) {
    throw new Error(`Wardrobe board size must be an integer >= 2, got ${size}`);
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    const level = tryReverseBuild(size, rand);
    if (level) return level;
  }
  throw new Error("Failed to generate a wardrobe level");
}
