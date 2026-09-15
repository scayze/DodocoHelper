import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isCrownsStored, type CrownsStored } from "../src/games/crowns/stored.js";
import { generatePuzzle } from "../src/games/crowns/generator.js";
import { solvePuzzle } from "../src/games/crowns/solver.js";
import { nextMark } from "../src/games/crowns/marks.js";
import { isMineStored } from "../src/games/minesweeper/stored.js";
import { createPreplacedBoard } from "../src/games/minesweeper/logic.js";
import { generateMines } from "../src/games/minesweeper/generator.js";
import { isSeasonsStored } from "../src/games/seasons/stored.js";
import { createBoard as createSeasonsBoard, SEASONS_SIZE } from "../src/games/seasons/logic.js";
import { generateRandomLevel } from "../src/games/seasons/generator.js";
import { isTentsStored } from "../src/games/tents/stored.js";
import { createBoard as createTentsBoard, TENTS_DEFAULT_SIZE } from "../src/games/tents/logic.js";
import { generateLevel } from "../src/games/tents/generator.js";
import { mulberry32 } from "../src/games/rng.js";

describe("crowns stored boards", () => {
  it("accepts a real played daily (undo) and rejects tampering", () => {
    const puzzle = generatePuzzle(9, 2, 1200, mulberry32(42));
    const solved = solvePuzzle(puzzle);
    assert.equal(solved.status, "solved");
    const undo = [{ r: 0, c: 0, prev: puzzle.initial[0][0] }];
    puzzle.initial[0][0] = nextMark(puzzle.initial[0][0]);
    const stored: CrownsStored = {
      puzzle,
      solution: solved.solution!,
      undo,
      solved: false,
    };
    const round = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
    assert.ok(isCrownsStored(round), "real crowns board must restore");
    // A mark outside C/.? must be rejected.
    (round as { puzzle: { initial: string[][] } }).puzzle.initial[0][0] = "X";
    assert.equal(isCrownsStored(round), false);
  });
});

describe("minesweeper stored boards", () => {
  it("accepts a real preplaced board whose adjacent grid holds -1 on mines", () => {
    const { mines, opening } = generateMines(9, 15, mulberry32(7));
    const board = createPreplacedBoard(9, 15, mines);
    // Regression: adjacent counts are -1 on mines; the validator must accept them.
    assert.ok(board.adjacent.flat().some((v) => v === -1), "fixture must contain -1 adjacent cells");
    const state = { board, opening, started: true, resultReported: false };
    const round = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    assert.ok(isMineStored(round), "real minesweeper board must restore");
    // A stored mine count that contradicts the layout must be rejected.
    (round as { board: { mineCount: number } }).board.mineCount = 14;
    assert.equal(isMineStored(round), false);
  });
});

describe("seasons stored boards", () => {
  it("accepts a real generated level and rejects bogus tile types", () => {
    const levelData = generateRandomLevel(SEASONS_SIZE, { rand: mulberry32(3) });
    const board = createSeasonsBoard(SEASONS_SIZE);
    board.cells = levelData.cells;
    const state = { board, moveCount: 2, resultReported: false };
    const round = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    assert.ok(isSeasonsStored(round), "real seasons board must restore");
    (round as { board: { cells: Array<Array<{ t: string } | null>> } }).board.cells[0][0] = { t: "bogus" };
    assert.equal(isSeasonsStored(round), false);
  });
});

describe("tents stored boards", () => {
  it("accepts a real generated level and rejects bad marks", () => {
    const levelData = generateLevel(TENTS_DEFAULT_SIZE, mulberry32(5));
    const board = createTentsBoard(levelData);
    const state = {
      board,
      moveCount: 1,
      undoStack: [{ r: 0, c: 0, prev: "unknown" }],
      winReported: false,
    };
    const round = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    assert.ok(isTentsStored(round), "real tents board must restore");
    (round as { board: { marks: string[][] } }).board.marks[0][0] = "hut";
    assert.equal(isTentsStored(round), false);
  });
});