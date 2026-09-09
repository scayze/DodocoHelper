import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createBoard,
  findRegion,
  hasAvailableMove,
  isCleared,
  remainingCount,
  removeRegion,
  type SeasonType,
  type SeasonsBoard,
} from "../src/games/seasons/logic.js";

let nextTestId = 1;

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
