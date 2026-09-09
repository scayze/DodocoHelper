import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SEASON_TYPES,
  countRegions,
  countSingles,
  createBoard,
  findRegion,
  generateLevel,
  hasAvailableMove,
  isCleared,
  remainingCount,
  removeRegion,
  verifySolution,
  type SeasonType,
  type SeasonsBoard,
} from "../src/games/seasons/logic.js";

let nextTestId = 1;

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

function boardFrom(rows: Array<Array<SeasonType | null>>): SeasonsBoard {
  return {
    size: rows.length,
    cells: rows.map((row) =>
      row.map((t) => (t === null ? null : { t, id: nextTestId++ })),
    ),
    over: false,
    won: false,
  };
}

/** Plain type grid for assertions (tiles carry ids for animation). */
function tops(board: SeasonsBoard): Array<Array<SeasonType | null>> {
  return board.cells.map((row) => row.map((cell) => cell?.t ?? null));
}

describe("seasons regions", () => {
  it("flood-fills orthogonally and ignores diagonals", () => {
    const board = boardFrom([
      ["autumn", "autumn", "winter"],
      ["winter", "autumn", "winter"],
      ["winter", "winter", "spring"],
    ]);
    const region = findRegion(board, 0, 0);
    assert.deepEqual(
      region.sort(),
      [[0, 0], [0, 1], [1, 1]].sort(),
    );
    // (2,2) is a spring with no matching orthogonal neighbor: singleton region.
    assert.equal(findRegion(board, 2, 2).length, 1);
  });

  it("returns [] for empty and out-of-bounds cells", () => {
    const board = boardFrom([
      ["autumn", null],
      [null, "winter"],
    ]);
    assert.deepEqual(findRegion(board, 0, 1), []);
    assert.deepEqual(findRegion(board, -1, 0), []);
    assert.deepEqual(findRegion(board, 0, 9), []);
  });
});

describe("seasons removal", () => {
  it("rejects singletons without touching the board", () => {
    const board = boardFrom([
      ["autumn", "winter"],
      ["spring", "summer"],
    ]);
    const before = board.cells.map((row) => [...row]);
    assert.equal(removeRegion(board, findRegion(board, 0, 0)), false);
    assert.deepEqual(board.cells, before);
    assert.equal(board.over, false);
  });

  it("removes groups and lets squares above fall down", () => {
    const board = boardFrom([
      ["autumn", "spring", "winter"],
      ["summer", "winter", "winter"],
      ["summer", "winter", "spring"],
    ]);
    assert.equal(removeRegion(board, findRegion(board, 1, 1)), true);
    assert.deepEqual(tops(board), [
      ["autumn", null, null],
      ["summer", null, null],
      ["summer", "spring", "spring"],
    ]);
    assert.equal(remainingCount(board), 5);
    assert.equal(board.over, false);
  });

  it("collapses emptied columns to the right, order preserved", () => {
    const board = boardFrom([
      ["autumn", "winter", "spring"],
      ["autumn", "winter", "spring"],
      ["autumn", "winter", "summer"],
    ]);
    assert.equal(removeRegion(board, findRegion(board, 0, 1)), true);
    // The middle column is gone: survivors shift right, empties pad the left.
    assert.deepEqual(tops(board), [
      [null, "autumn", "spring"],
      [null, "autumn", "spring"],
      [null, "autumn", "summer"],
    ]);
  });

  it("wins when the last square clears", () => {
    const board = boardFrom([
      ["autumn", "autumn"],
      ["winter", "winter"],
    ]);
    assert.equal(removeRegion(board, findRegion(board, 0, 0)), true);
    assert.equal(removeRegion(board, findRegion(board, 1, 1)), true);
    assert.equal(isCleared(board), true);
    assert.equal(remainingCount(board), 0);
    assert.equal(board.over, true);
    assert.equal(board.won, true);
  });

  it("loses when tiles remain but no group is clickable", () => {
    const board = boardFrom([
      ["autumn", "autumn"],
      ["winter", "spring"],
    ]);
    assert.equal(hasAvailableMove(board), true);
    assert.equal(removeRegion(board, findRegion(board, 0, 0)), true);
    // winter vs spring: both singletons, nothing left to click.
    assert.equal(remainingCount(board), 2);
    assert.equal(hasAvailableMove(board), false);
    assert.equal(board.over, true);
    assert.equal(board.won, false);
    // The dead board accepts no further moves.
    assert.equal(removeRegion(board, findRegion(board, 1, 0)), false);
  });
});

describe("seasons stuck detection", () => {
  it("reports no move on all-singleton and empty boards", () => {
    assert.equal(
      hasAvailableMove(
        boardFrom([
          ["autumn", "winter"],
          ["spring", "summer"],
        ]),
      ),
      false,
    );
    assert.equal(hasAvailableMove(createBoard(4)), false);
  });

  it("reports a move when any pair touches", () => {
    assert.equal(
      hasAvailableMove(
        boardFrom([
          ["autumn", "winter"],
          ["spring", "autumn"],
        ]),
      ),
      false,
    );
    assert.equal(
      hasAvailableMove(
        boardFrom([
          ["autumn", "winter"],
          ["autumn", "spring"],
        ]),
      ),
      true,
    );
  });
});

describe("seasons generator", () => {
  it("produces full 10x10 boards using known season types", () => {
    for (let i = 0; i < 3; i++) {
      const { cells, solution } = generateLevel();
      assert.equal(cells.length, 10);
      for (const row of cells) {
        assert.equal(row.length, 10);
        for (const cell of row) {
          assert.notEqual(cell, null);
          assert.ok(SEASON_TYPES.includes(cell!.t));
        }
      }
      // Every tile belongs to exactly one solution group.
      const ids = solution.flat().sort((a, b) => a - b);
      assert.equal(ids.length, 100);
      assert.deepEqual(ids, Array.from({ length: 100 }, (_, k) => k + 1));
    }
  });

  /**
   * Proof test: generation runs a game backwards, so the solution groups in
   * order always clear the board through legal moves.
   */
  it("generated levels always clear fully in solution order", () => {
    for (let i = 0; i < 5; i++) {
      const { cells, solution } = generateLevel(10, mulberry32(9000 + i));
      assert.equal(verifySolution(cells, solution, 10), true);
    }
    const unseeded = generateLevel();
    assert.equal(verifySolution(unseeded.cells, unseeded.solution, 10), true);
  });

  /** Splits and beams fragment clusters, so fresh boards stay mixed. */
  it("generates fragmented boards with horizontal bonds", () => {
    for (let i = 0; i < 5; i++) {
      const { cells } = generateLevel(10, mulberry32(5000 + i));
      assert.ok(
        countRegions(cells, 10) >= 25,
        "fresh boards stay fragmented instead of slabbing",
      );
      assert.ok(
        countSingles(cells, 10) >= 6,
        "fragmentation strands a few singleton tiles",
      );
      let pairs = 0;
      for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 9; c++) {
          if (cells[r][c]?.t === cells[r][c + 1]?.t) pairs++;
        }
      }
      assert.ok(pairs >= 6, `expected horizontal bars, got ${pairs}`);
    }
  });

  it("supports generic sizes", () => {
    for (const size of [2, 4, 6]) {
      const { cells, solution } = generateLevel(size, mulberry32(size));
      assert.equal(cells.length, size);
      for (const row of cells) assert.equal(row.length, size);
      assert.equal(verifySolution(cells, solution, size), true);
    }
    assert.throws(() => generateLevel(1), /integer >= 2/);
  });
});
