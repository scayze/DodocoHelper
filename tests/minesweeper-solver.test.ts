import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeAdjacent,
  findBestOpening,
  isLogicSolvableFrom,
} from "../src/games/minesweeper/solver.js";
import { generateMines } from "../src/games/minesweeper/generator.js";
import {
  createPreplacedBoard,
  ensureFirstClickSafe,
} from "../src/games/minesweeper/logic.js";
import { mulberry32 } from "../src/games/daily.js";

function minesFromList(size: number, cells: Array<[number, number]>): boolean[][] {
  const mines: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  for (const [r, c] of cells) mines[r][c] = true;
  return mines;
}

describe("minesweeper solver", () => {
  it("solves a singles-only board from its opening", () => {
    // 3x3, one mine at (0,0); (2,2) floods everything safe.
    const mines = minesFromList(3, [[0, 0]]);
    assert.equal(isLogicSolvableFrom(mines, 3, 2, 2), true);
  });

  it("reports a pure-guess position as unsolvable", () => {
    // 2x2, mine at (0,0): no zero cells; starting at (1,1) reveals a lone
    // "1" with three hidden neighbors — a 1-in-3 guess no logic can resolve.
    const mines = minesFromList(2, [[0, 0]]);
    assert.equal(isLogicSolvableFrom(mines, 2, 1, 1), false);
  });

  it("rejects openings sitting on a mine", () => {
    const mines = minesFromList(3, [[1, 1]]);
    assert.equal(isLogicSolvableFrom(mines, 3, 1, 1), false);
  });

  it("findBestOpening returns a zero-cell opening when one solves", () => {
    const mines = minesFromList(3, [[0, 0]]);
    const opening = findBestOpening(mines, 3);
    assert.ok(opening);
    const adjacent = computeAdjacent(mines, 3);
    assert.equal(adjacent[opening!.r][opening!.c], 0);
    assert.equal(isLogicSolvableFrom(mines, 3, opening!.r, opening!.c), true);
  });

  it("findBestOpening returns null when no zero cell exists", () => {
    const mines = minesFromList(2, [[0, 0]]);
    assert.equal(findBestOpening(mines, 2), null);
  });
});

describe("minesweeper generator", () => {
  it("is deterministic per seed", () => {
    const a = generateMines(9, 15, mulberry32(42));
    const b = generateMines(9, 15, mulberry32(42));
    assert.deepEqual(a.mines, b.mines);
    assert.deepEqual(a.opening, b.opening);
  });

  it("differs across seeds", () => {
    const a = generateMines(9, 15, mulberry32(42));
    const b = generateMines(9, 15, mulberry32(43));
    assert.notDeepEqual(a.mines, b.mines);
  });

  it("emits solvable zero-openings across a seed sweep (daily 9x9/15)", () => {
    for (let seed = 100; seed < 120; seed++) {
      const { mines, opening, attempts } = generateMines(9, 15, mulberry32(seed));
      assert.ok(attempts >= 1);
      let count = 0;
      for (const row of mines) for (const m of row) if (m) count++;
      assert.equal(count, 15);
      const adjacent = computeAdjacent(mines, 9);
      assert.equal(adjacent[opening.r][opening.c], 0);
      assert.equal(isLogicSolvableFrom(mines, 9, opening.r, opening.c), true);
    }
  });

  it("emits solvable boards at endless sizes", () => {
    for (const [size, count] of [[6, 8], [12, 40]] as const) {
      const { mines, opening } = generateMines(size, count, mulberry32(size * 1000 + count));
      assert.equal(isLogicSolvableFrom(mines, size, opening.r, opening.c), true);
    }
  });

  it("validates size and mine count", () => {
    assert.throws(() => generateMines(1, 1, mulberry32(1)));
    assert.throws(() => generateMines(9, 0, mulberry32(1)));
    assert.throws(() => generateMines(9, 41, mulberry32(1)));
  });
});

describe("preplaced boards", () => {
  it("arrives placed with correct adjacency", () => {
    const { mines } = generateMines(9, 15, mulberry32(7));
    const board = createPreplacedBoard(9, 15, mines);
    assert.equal(board.placed, true);
    assert.deepEqual(board.adjacent, computeAdjacent(mines, 9));
    assert.equal(board.revealedCount, 0);
  });

  it("relocates a mine under an off-hint first click, keeping the count", () => {
    const mines = minesFromList(9, [[4, 4]]);
    // Fill remaining 14 mines far from (4,4).
    let extra: Array<[number, number]> = [];
    for (let r = 0; r < 9 && extra.length < 14; r++) {
      for (let c = 0; c < 9 && extra.length < 14; c++) {
        if (Math.abs(r - 4) > 1 || Math.abs(c - 4) > 1) extra.push([r, c]);
      }
    }
    for (const [r, c] of extra) mines[r][c] = true;
    const board = createPreplacedBoard(9, 15, mines);
    ensureFirstClickSafe(board, 4, 4, mulberry32(9));
    assert.equal(board.mines[4][4], false);
    let count = 0;
    for (const row of board.mines) for (const m of row) if (m) count++;
    assert.equal(count, 15);
  });

  it("leaves safe first clicks untouched", () => {
    const { mines } = generateMines(9, 15, mulberry32(11));
    const board = createPreplacedBoard(9, 15, mines);
    const before = board.mines.map((row) => [...row]);
    // A zero opening cell is never a mine.
    const { opening } = generateMines(9, 15, mulberry32(11));
    ensureFirstClickSafe(board, opening.r, opening.c, mulberry32(12));
    assert.deepEqual(board.mines, before);
  });
});
