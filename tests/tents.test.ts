import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkWin,
  countSolutions,
  createBoard,
  generateLevel,
  solveTents,
  tentsPlaced,
  toggleMark,
  validateLevelData,
  type TentsLevel,
} from "../src/games/tents/logic.js";

/** Deterministic rand for stable generator assertions. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function applyTents(level: TentsLevel, tents: boolean[][]): ReturnType<typeof createBoard> {
  const board = createBoard(level);
  for (let r = 0; r < level.size; r++) {
    for (let c = 0; c < level.size; c++) {
      if (tents[r][c]) board.marks[r][c] = "tent";
    }
  }
  return board;
}

describe("tents marks", () => {
  it("cycles unknown -> grass -> tent -> unknown and skips trees", () => {
    const level = generateLevel(6, mulberry32(1));
    const board = createBoard(level);
    let r = 0;
    let c = 0;
    outer: for (let i = 0; i < level.size; i++) {
      for (let j = 0; j < level.size; j++) {
        if (!level.trees[i][j]) {
          r = i;
          c = j;
          break outer;
        }
      }
    }
    assert.equal(board.marks[r][c], "unknown");
    assert.equal(toggleMark(board, r, c), true);
    assert.equal(board.marks[r][c], "grass");
    assert.equal(toggleMark(board, r, c), true);
    assert.equal(board.marks[r][c], "tent");
    assert.equal(toggleMark(board, r, c), true);
    assert.equal(board.marks[r][c], "unknown");
    // Tree cells refuse marks.
    const t = level.trees.flatMap((row, i) => row.map((v, j) => (v ? [i, j] as const : null)).filter(Boolean));
    assert.ok(t.length > 0);
    assert.equal(toggleMark(board, t[0]![0], t[0]![1]), false);
  });
});

describe("tents rules", () => {
  it("accepts a generated solution as a win", () => {
    const level = generateLevel(6, mulberry32(2));
    const board = applyTents(level, level.solution);
    assert.equal(checkWin(board), true);
    assert.equal(board.over, true);
    assert.equal(board.won, true);
  });

  it("rejects touching tents (including diagonal)", () => {
    // Trees at (0,0) and (2,2); tents at (0,1) and (1,1) touch diagonally.
    const size = 4;
    const trees = Array.from({ length: size }, () => Array(size).fill(false));
    trees[0][0] = true;
    trees[2][2] = true;
    const level: TentsLevel = {
      size,
      trees,
      rowCounts: [1, 1, 0, 0],
      colCounts: [0, 2, 0, 0],
      solution: Array.from({ length: size }, () => Array(size).fill(false)),
    };
    const board = createBoard(level);
    board.marks[0][1] = "tent";
    board.marks[1][1] = "tent";
    assert.equal(checkWin(board), false);
  });

  it("rejects wrong row counts and unpaired trees", () => {
    const level = generateLevel(6, mulberry32(3));
    const board = applyTents(level, level.solution);
    assert.equal(checkWin(board), true);
    // Clear one tent: counts and pairing break.
    outer: for (let r = 0; r < level.size; r++) {
      for (let c = 0; c < level.size; c++) {
        if (board.marks[r][c] === "tent") {
          board.marks[r][c] = "unknown";
          break outer;
        }
      }
    }
    board.over = false;
    board.won = false;
    assert.equal(checkWin(board), false);
    assert.equal(tentsPlaced(board), level.rowCounts.reduce((a, b) => a + b, 0) - 1);
  });

  it("allows orthogonally adjacent trees when each keeps its own tent", () => {
    // Trees (1,1)+(1,2) adjacent; tents above each at (0,1),(0,2) would
    // touch, so pair them below/above instead: (0,1) goes with (1,1) and
    // (2,2) goes with (1,2). Tents (0,1),(2,2) don't touch.
    const size = 4;
    const trees = Array.from({ length: size }, () => Array(size).fill(false));
    trees[1][1] = true;
    trees[1][2] = true;
    const tents = Array.from({ length: size }, () => Array(size).fill(false));
    tents[0][1] = true;
    tents[2][2] = true;
    const level: TentsLevel = {
      size,
      trees,
      rowCounts: [1, 0, 1, 0],
      colCounts: [0, 1, 1, 0],
      solution: tents,
    };
    assert.equal(validateLevelData(trees, level.rowCounts, level.colCounts), null);
    const board = applyTents(level, tents);
    assert.equal(checkWin(board), true);
  });
});

describe("tents solver", () => {
  it("solves a tiny board with a unique solution", () => {
    // Single tree: row/col counts force the tent to (0,1).
    const size = 3;
    const trees = Array.from({ length: size }, () => Array(size).fill(false));
    trees[1][1] = true;
    const rows = [1, 0, 0];
    const cols = [0, 1, 0];
    const solved = solveTents(trees, rows, cols);
    assert.ok(solved);
    assert.equal(solved[0][1], true);
    assert.equal(countSolutions(trees, rows, cols, 2), 1);
  });

  it("counts a symmetric board as ambiguous", () => {
    const size = 4;
    const trees = Array.from({ length: size }, () => Array(size).fill(false));
    trees[1][1] = true;
    trees[1][2] = true;
    const rows = [1, 0, 1, 0];
    const cols = [0, 1, 1, 0];
    assert.equal(countSolutions(trees, rows, cols, 2), 2);
  });

  it("returns null when no placement fits", () => {
    const size = 3;
    const trees = Array.from({ length: size }, () => Array(size).fill(false));
    trees[1][1] = true;
    // Demanding the tent in row 0 while the tree only reaches rows 0-2
    // cols 0-2: force an impossible count (tent must be in row 2).
    assert.equal(solveTents(trees, [0, 0, 1], [0, 0, 1]), null);
    assert.equal(solveTents(trees, [0, 0, 1], [1, 0, 0]), null);
  });
});

describe("tents generator", () => {
  it("produces uniquely solvable boards at the default size", () => {
    for (let i = 0; i < 3; i++) {
      const level = generateLevel(8, mulberry32(100 + i));
      assert.equal(level.size, 8);
      assert.equal(validateLevelData(level.trees, level.rowCounts, level.colCounts), null);
      assert.equal(countSolutions(level.trees, level.rowCounts, level.colCounts, 2), 1);
      const board = applyTents(level, level.solution);
      assert.equal(checkWin(board), true);
    }
  });

  it("supports variable sizes", () => {
    for (const size of [4, 6, 10]) {
      const level = generateLevel(size, mulberry32(size * 7));
      assert.equal(level.trees.length, size);
      assert.equal(countSolutions(level.trees, level.rowCounts, level.colCounts, 2), 1);
    }
  });

  it("rejects bad sizes", () => {
    assert.throws(() => generateLevel(1), /integer >= 2/);
  });
});
