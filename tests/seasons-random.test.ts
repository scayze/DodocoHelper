import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findRegion,
  remainingCount,
  removeRegion,
  type SeasonsBoard,
  type SeasonType,
} from "../src/games/seasons/logic.js";
import { generateRandomLevel } from "../src/games/seasons/generator.js";
import { isSolvableTypes } from "../src/games/seasons/solver.js";

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

function typesOf(
  cells: Array<Array<{ t: SeasonType } | null>>,
): (SeasonType | null)[][] {
  return cells.map((row) => row.map((c) => c?.t ?? null));
}

/**
 * Strict replay through the real game rules: every move must be a legal
 * region of size >= 2 with no stuck-flag bypass, ending in a full clear.
 */
function replaysToClear(
  cells: Array<Array<{ t: SeasonType; id: number } | null>>,
  solution: number[][] | null,
  size: number,
): boolean {
  if (!solution) return false;
  const board: SeasonsBoard = {
    size,
    cells: cells.map((row) => row.map((c) => (c === null ? null : { ...c }))),
    over: false,
    won: false,
  };
  for (const move of solution) {
    const first = move[0]!;
    const region = findRegion(board, Math.floor(first / size), first % size);
    if (region.length < 2) return false;
    const got = new Set(region.map(([r, c]) => r * size + c));
    if (got.size !== move.length || !move.every((i) => got.has(i))) return false;
    if (!removeRegion(board, region)) return false;
  }
  return remainingCount(board) === 0 && board.over && board.won;
}

describe("random level shape", () => {
  it("emits full boards with dense ids for square and rectangular sizes", () => {
    const cases: Array<{ size: number | { rows: number; cols: number }; rows: number; cols: number }> = [
      { size: 2, rows: 2, cols: 2 },
      { size: 3, rows: 3, cols: 3 },
      { size: 4, rows: 4, cols: 4 },
      { size: 6, rows: 6, cols: 6 },
      { size: 10, rows: 10, cols: 10 },
      { size: { rows: 3, cols: 5 }, rows: 3, cols: 5 },
      { size: { rows: 5, cols: 3 }, rows: 5, cols: 3 },
    ];
    let seed = 100;
    for (const { size, rows, cols } of cases) {
      const lvl = generateRandomLevel(size, { rand: mulberry32(seed++) });
      assert.equal(lvl.rows, rows);
      assert.equal(lvl.cols, cols);
      assert.equal(lvl.cells.length, rows);
      const ids: number[] = [];
      for (const row of lvl.cells) {
        assert.equal(row.length, cols);
        for (const cell of row) {
          assert.notEqual(cell, null);
          assert.ok(["summer", "autumn", "spring", "winter"].includes(cell!.t));
          ids.push(cell!.id);
        }
      }
      assert.deepEqual(
        ids.sort((a, b) => a - b),
        Array.from({ length: rows * cols }, (_, k) => k + 1),
      );
    }
  });

  it("rejects bad dimensions", () => {
    assert.throws(() => generateRandomLevel(1), /integers >= 2/);
    assert.throws(() => generateRandomLevel(0), /integers >= 2/);
    assert.throws(() => generateRandomLevel(2.5), /integers >= 2/);
    assert.throws(() => generateRandomLevel({ rows: 1, cols: 5 }), /integers >= 2/);
    assert.throws(() => generateRandomLevel({ rows: 4, cols: 0 }), /integers >= 2/);
  });
});

describe("random level solvability", () => {
  it("every emitted square board clears through legal game moves", () => {
    const cases: Array<[number, number[]]> = [
      [2, [200, 201, 202, 203, 204]],
      [3, [210, 211, 212]],
      [4, [220, 221, 222]],
      [6, [230, 231]],
      [10, [7000, 7001, 7002]],
    ];
    for (const [size, seeds] of cases) {
      for (const seed of seeds) {
        const lvl = generateRandomLevel(size, { rand: mulberry32(seed) });
        assert.ok(lvl.solution, `size ${size} seed ${seed}: solution tracked`);
        assert.equal(
          replaysToClear(lvl.cells, lvl.solution, size),
          true,
          `size ${size} seed ${seed}: solution must fully clear`,
        );
      }
    }
  });

  it("rectangular output round-trips through a fresh solver run", () => {
    // SeasonsBoard is square-oriented, so rectangles are checked by an
    // independent solver pass over the emitted types instead of a replay.
    for (const dims of [
      { rows: 3, cols: 5 },
      { rows: 5, cols: 3 },
    ]) {
      const lvl = generateRandomLevel(dims, { rand: mulberry32(300) });
      const check = isSolvableTypes(typesOf(lvl.cells), {
        maxStates: 200_000,
        maxMs: 5_000,
      });
      assert.equal(check.result, "solvable");
    }
  });

  it("keeps repair edits tiny (near-uniform footprint)", () => {
    // Deterministic seeds: these bounds are stable, not flaky.
    for (const seed of [7000, 7001, 7002]) {
      const lvl = generateRandomLevel(10, { rand: mulberry32(seed) });
      const edits = lvl.edits.recolors + lvl.edits.swaps;
      assert.ok(edits <= 2, `10x10 seed ${seed}: edits=${edits}`);
      assert.equal(lvl.fills, 1);
    }
    // 4x4 seed 5013 needed the most repair observed (5 edits).
    const small = generateRandomLevel(4, { rand: mulberry32(5013) });
    assert.ok(
      small.edits.recolors + small.edits.swaps <= 6,
      `edits=${JSON.stringify(small.edits)}`,
    );
    assert.equal(small.fills, 1);
    assert.equal(replaysToClear(small.cells, small.solution, 4), true);
  });
});

describe("random level determinism and options", () => {
  it("reproduces identical boards for the same rand stream", () => {
    const a = generateRandomLevel(6, { rand: mulberry32(42) });
    const b = generateRandomLevel(6, { rand: mulberry32(42) });
    assert.deepEqual(typesOf(a.cells), typesOf(b.cells));
    assert.deepEqual(a.solution, b.solution);
    assert.deepEqual(a.edits, b.edits);
  });

  it("omits the solution path when disabled but stays solvable", () => {
    const lvl = generateRandomLevel(6, {
      rand: mulberry32(77),
      solution: false,
    });
    assert.equal(lvl.solution, null);
    const check = isSolvableTypes(typesOf(lvl.cells), {
      maxStates: 200_000,
      maxMs: 5_000,
      trackSolution: true,
    });
    assert.equal(check.result, "solvable");
    assert.equal(replaysToClear(lvl.cells, check.solution ?? null, 6), true);
  });
});
