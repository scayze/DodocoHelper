import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MINES_COUNT,
  MINES_SIZE,
  chord,
  createBoard,
  minePositions,
  placeMines,
  reveal,
  toggleFlag,
  type MineBoard,
} from "../src/games/minesweeper/logic.js";

describe("minesweeper board", () => {
  it("creates a 9x9 all-hidden board", () => {
    const board = createBoard();
    assert.equal(board.size, MINES_SIZE);
    assert.equal(board.mineCount, MINES_COUNT);
    assert.equal(board.placed, false);
    assert.equal(board.over, false);
    for (const row of board.state) {
      for (const cell of row) assert.equal(cell, "hidden");
    }
  });

  it("places exactly 10 mines, never on the first-clicked cell", () => {
    const board = createBoard();
    placeMines(board, 4, 4);
    assert.equal(board.placed, true);
    assert.equal(minePositions(board).length, MINES_COUNT);
    assert.equal(board.mines[4][4], false);
  });

  it("first reveal is always safe and marks the board placed", () => {
    const board = createBoard();
    const hitMine = reveal(board, 0, 0);
    assert.equal(hitMine, false);
    assert.equal(board.placed, true);
    assert.equal(board.state[0][0], "revealed");
  });

  it("flood-fills through zero-adjacent cells", () => {
    const empty = createBoard(3, 0);
    reveal(empty, 0, 0);
    assert.equal(empty.revealedCount, 9);
    assert.equal(empty.over, true);
    assert.equal(empty.won, true);
  });

  it("hitting a mine ends the game as a loss", () => {
    const board = createBoard(3, 1);
    board.mines[1][1] = true;
    board.adjacent[1][1] = -1;
    board.placed = true;
    const hitMine = reveal(board, 1, 1);
    assert.equal(hitMine, true);
    assert.equal(board.over, true);
    assert.equal(board.won, false);
  });

  it("flagged cells cannot be revealed and toggle back", () => {
    const board = createBoard(3, 0);
    board.placed = true;
    toggleFlag(board, 1, 1);
    assert.equal(board.state[1][1], "flagged");
    const hitMine = reveal(board, 1, 1);
    assert.equal(hitMine, false);
    assert.equal(board.state[1][1], "flagged");
    toggleFlag(board, 1, 1);
    assert.equal(board.state[1][1], "hidden");
  });

  it("revealing all safe cells wins the game", () => {
    const board = createBoard(2, 1);
    board.mines[0][0] = true;
    board.adjacent[0][0] = -1;
    board.adjacent[0][1] = 1;
    board.adjacent[1][0] = 1;
    board.adjacent[1][1] = 1;
    board.placed = true;
    reveal(board, 0, 1);
    reveal(board, 1, 0);
    reveal(board, 1, 1);
    assert.equal(board.over, true);
    assert.equal(board.won, true);
  });
});

describe("chord", () => {
  /** 3x3 board with a single mine at (0,0); (0,1) reads 1. */
  function singleMineBoard(): MineBoard {
    const board = createBoard(3, 1);
    board.mines[0][0] = true;
    board.adjacent[0][0] = -1;
    board.adjacent[0][1] = 1;
    board.adjacent[1][0] = 1;
    board.adjacent[1][1] = 1;
    board.placed = true;
    return board;
  }

  it("reveals remaining neighbors when flags satisfy the number", () => {
    const board = singleMineBoard();
    reveal(board, 0, 1);
    toggleFlag(board, 0, 0);
    const hitMine = chord(board, 0, 1);
    assert.equal(hitMine, false);
    assert.equal(board.state[0][2], "revealed");
    assert.equal(board.state[1][0], "revealed");
    assert.equal(board.state[1][1], "revealed");
    assert.equal(board.state[0][0], "flagged");
  });

  it("does nothing when the flag count does not match", () => {
    const board = singleMineBoard();
    reveal(board, 0, 1);
    const hitMine = chord(board, 0, 1);
    assert.equal(hitMine, false);
    assert.equal(board.state[0][2], "hidden");
    assert.equal(board.state[1][0], "hidden");
    assert.equal(board.over, false);
  });

  it("hits a mine when a flag was misplaced", () => {
    const board = singleMineBoard();
    reveal(board, 1, 1);
    // (1,1) reads 1; flag a safe neighbor instead of the mine.
    toggleFlag(board, 0, 1);
    const hitMine = chord(board, 1, 1);
    assert.equal(hitMine, true);
    assert.equal(board.over, true);
    assert.equal(board.won, false);
  });

  it("ignores hidden cells and zero cells", () => {
    const board = singleMineBoard();
    assert.equal(chord(board, 0, 1), false);
    const empty = createBoard(3, 0);
    reveal(empty, 1, 1);
    assert.equal(chord(empty, 1, 1), false);
    assert.equal(empty.over, true);
    assert.equal(empty.won, true);
  });
});
