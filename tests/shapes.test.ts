import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CELL_COUNT,
  cardKey,
  type Card,
} from "../src/games/shapes/types.js";
import {
  allCardsDistinct,
  checkWin,
  createBoard,
  featureOk,
  isValidQuad,
  isValidSet,
  rowCards,
  rowIsValid,
  swapCells,
  validRows,
} from "../src/games/shapes/logic.js";
import { countSolutions, findValidQuads } from "../src/games/shapes/solver.js";
import { generatePuzzle } from "../src/games/shapes/generator.js";
import { isShapesStored } from "../src/games/shapes/stored.js";
import { mulberry32 } from "../src/games/daily.js";

const ALL_SAME: [Card, Card, Card, Card] = [
  [0, 1, 2, 3],
  [0, 1, 2, 3],
  [0, 1, 2, 3],
  [0, 1, 2, 3],
];

const ALL_DIFF: [Card, Card, Card, Card] = [
  [0, 0, 0, 0],
  [1, 1, 1, 1],
  [2, 2, 2, 2],
  [3, 3, 3, 3],
];

describe("shapes feature check", () => {
  it("accepts all-same and all-different, rejects the middle cases", () => {
    assert.equal(featureOk([2, 2, 2, 2]), true);
    assert.equal(featureOk([0, 1, 2, 3]), true);
    assert.equal(featureOk([0, 0, 1, 2]), false); // 2+1+1
    assert.equal(featureOk([0, 0, 1, 1]), false); // 2+2
    assert.equal(featureOk([0, 1, 1, 1]), false); // 3+1
  });
});

describe("shapes set validity", () => {
  it("accepts uniform and fully varied quads", () => {
    assert.equal(isValidQuad(...ALL_SAME), true);
    assert.equal(isValidQuad(...ALL_DIFF), true);
  });

  it("accepts mixed per-feature modes", () => {
    // color same, shape different, count 2+2 (invalid) -> overall invalid
    assert.equal(
      isValidQuad([1, 0, 0, 0], [1, 1, 0, 0], [1, 2, 1, 1], [1, 3, 1, 1]),
      false,
    );
    // color same, shape different, count same, pattern different -> valid
    assert.equal(
      isValidQuad([1, 0, 2, 0], [1, 1, 2, 1], [1, 2, 2, 2], [1, 3, 2, 3]),
      true,
    );
  });

  it("rejects wrong-length inputs", () => {
    assert.equal(isValidSet([]), false);
    assert.equal(isValidSet([[0, 0, 0, 0]]), false);
  });
});

describe("shapes board helpers", () => {
  it("reads rows through the position map and swaps cells", () => {
    const cards: Card[] = Array.from({ length: 16 }, (_, i) => [
      i % 4,
      Math.floor(i / 4) % 4,
      0,
      0,
    ]);
    const pos = Array.from({ length: 16 }, (_, i) => i);
    const board = createBoard(cards, pos);
    assert.deepEqual(
      rowCards(board, 0).map(cardKey),
      cards.slice(0, 4).map(cardKey),
    );
    assert.equal(swapCells(board, 0, 15), true);
    assert.equal(board.pos[0], 15);
    assert.equal(board.pos[15], 0);
    assert.equal(swapCells(board, 0, 0), false);
    assert.equal(swapCells(board, -1, 3), false);
    assert.equal(swapCells(board, 0, 16), false);
  });

  it("detects wins only when every row is valid", () => {
    const quad: Card[] = [
      [0, 0, 0, 0],
      [0, 1, 1, 1],
      [0, 2, 2, 2],
      [0, 3, 3, 3],
    ];
    assert.equal(isValidSet(quad), true);
    const cards = [...quad, ...quad.map((c) => [1, c[1], c[2], c[3]] as Card),
      ...quad.map((c) => [2, c[1], c[2], c[3]] as Card),
      ...quad.map((c) => [3, c[1], c[2], c[3]] as Card)];
    const board = createBoard(cards, cards.map((_, i) => i));
    assert.deepEqual(validRows(board), [true, true, true, true]);
    assert.equal(checkWin(board), true);
    assert.equal(board.over, true);
    // Break one row: no longer won. (Reset over/won first: finished
    // boards refuse swaps.)
    board.over = false;
    board.won = false;
    swapCells(board, 0, 4);
    assert.equal(rowIsValid(board, 0), false);
    assert.equal(checkWin(board), false);
  });

  it("checks card distinctness", () => {
    assert.equal(allCardsDistinct(ALL_DIFF), true);
    assert.equal(allCardsDistinct(ALL_SAME), false);
  });
});

describe("shapes solver", () => {
  it("counts duplicated quads as ambiguous (cap 2)", () => {
    // Two copies of each card of a valid quad, twice over: many partitions.
    const quad: Card[] = [
      [0, 0, 0, 0],
      [0, 1, 1, 1],
      [0, 2, 2, 2],
      [0, 3, 3, 3],
    ];
    const cards = [...quad, ...quad, ...quad, ...quad];
    assert.ok(findValidQuads(cards).length > 1);
    assert.equal(countSolutions(cards, 2), 2);
  });

  it("returns 0 for bad input sizes", () => {
    assert.equal(countSolutions([], 2), 0);
    assert.equal(countSolutions([[0, 0, 0, 0]], 2), 0);
  });
});

describe("shapes generator", () => {
  it("deals unique, distinct, unsolved boards deterministically", () => {
    for (const seed of [1, 7, 42, 1234]) {
      const a = generatePuzzle(mulberry32(seed));
      const b = generatePuzzle(mulberry32(seed));
      assert.deepEqual(a, b);
      assert.equal(a.cards.length, CELL_COUNT);
      assert.equal(a.pos.length, CELL_COUNT);
      assert.equal(allCardsDistinct(a.cards), true);
      assert.deepEqual([...a.pos].sort((x, y) => x - y), a.cards.map((_, i) => i));
      assert.equal(countSolutions(a.cards, 2), 1);
      const board = createBoard(a.cards, a.pos);
      assert.deepEqual(validRows(board), [false, false, false, false]);
    }
  });

  it("deals unique boards across many seeds (acceptance probe)", () => {
    let validQuads = 0;
    for (let seed = 1000; seed < 1050; seed++) {
      const p = generatePuzzle(mulberry32(seed));
      assert.equal(countSolutions(p.cards, 2), 1);
      validQuads += findValidQuads(p.cards).length;
    }
    // Sanity: unique-solution boards carry a handful of valid quads
    // (the 4 planted ones plus rare accidental extras).
    const avg = validQuads / 50;
    assert.ok(avg >= 4 && avg < 8, `avg valid quads ${avg}`);
  });
});

describe("shapes stored slice", () => {
  function validStored(): unknown {
    const p = generatePuzzle(mulberry32(9));
    return {
      board: { cards: p.cards, pos: p.pos, over: false, won: false },
      moveCount: 3,
      selected: 5,
      winReported: false,
    };
  }

  it("accepts a well-formed slice", () => {
    assert.equal(isShapesStored(validStored()), true);
  });

  it("rejects corrupt slices", () => {
    assert.equal(isShapesStored(null), false);
    const badPos = validStored() as Record<string, unknown>;
    (badPos["board"] as Record<string, unknown>)["pos"] = [0, 1, 2];
    assert.equal(isShapesStored(badPos), false);
    const badCard = validStored() as Record<string, unknown>;
    (badCard["board"] as Record<string, unknown>)["cards"] = Array.from(
      { length: 16 },
      () => [0, 0, 0, 9],
    );
    assert.equal(isShapesStored(badCard), false);
    const badSel = validStored() as Record<string, unknown>;
    badSel["selected"] = 16;
    assert.equal(isShapesStored(badSel), false);
  });
});
