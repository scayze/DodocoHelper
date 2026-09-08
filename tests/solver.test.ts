import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validatePuzzleInput, validateSolution } from "../src/core/validator.js";
import { solveAll, solvePuzzle, testAssumption, testAssumptionDetailed } from "../src/core/solver.js";
import { findHints } from "../src/core/hints.js";
import { nextMark } from "../src/core/marks.js";
import { validatePuzzleInput as checkInput } from "../src/core/validator.js";
import { generatePuzzle } from "../src/core/generate.js";
import type { NormalizedPuzzle } from "../src/core/types.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Regions grown (seeded) around the KNOWN_CROWNS so the puzzle is solvable. */
const REGIONS: number[][] = [
  [0, 0, 0, 0, 0, 1, 1, 3, 2],
  [0, 2, 1, 1, 1, 3, 1, 3, 2],
  [4, 2, 2, 2, 3, 3, 3, 3, 2],
  [4, 3, 3, 3, 3, 3, 3, 4, 4],
  [4, 4, 4, 3, 5, 3, 3, 4, 4],
  [5, 5, 5, 5, 5, 5, 4, 4, 4],
  [5, 7, 5, 5, 8, 5, 6, 4, 6],
  [7, 7, 5, 7, 8, 8, 6, 8, 8],
  [7, 7, 5, 7, 8, 8, 8, 8, 8],
];

/** A hand-verified valid crown layout: 2 per row/col, no touching (incl. diagonal). */
const KNOWN_CROWNS: Array<[number, number]> = [
  [0, 0], [0, 2],
  [1, 4], [1, 6],
  [2, 1], [2, 8],
  [3, 3], [3, 5],
  [4, 0], [4, 7],
  [5, 2], [5, 4],
  [6, 6], [6, 8],
  [7, 1], [7, 3],
  [8, 5], [8, 7],
];

function blankInitial(): string[][] {
  return Array.from({ length: 9 }, () => Array(9).fill("?"));
}

function solutionGridFrom(crowns: Array<[number, number]>): string[][] {
  const g = Array.from({ length: 9 }, () => Array(9).fill("."));
  for (const [r, c] of crowns) g[r][c] = "C";
  return g;
}

function baseInput() {
  return { size: 9, crownsPerRow: 2, crownsPerColumn: 2, crownsPerRegion: 2, regions: REGIONS };
}

function normalized(input: unknown): NormalizedPuzzle {
  const { errors, puzzle } = checkInput(input);
  assert.deepEqual(errors, []);
  assert.ok(puzzle);
  return puzzle!;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("validatePuzzleInput", () => {
  it("accepts a well-formed puzzle", () => {
    const { errors, puzzle } = validatePuzzleInput({ ...baseInput(), initial: blankInitial() });
    assert.deepEqual(errors, []);
    assert.equal(puzzle?.size, 9);
  });

  it("defaults missing size/counts/initial", () => {
    const { errors, puzzle } = validatePuzzleInput({ regions: REGIONS });
    assert.deepEqual(errors, []);
    assert.equal(puzzle?.size, 9);
    assert.equal(puzzle?.crownsPerRow, 2);
    assert.equal(puzzle?.initial[0][0], "?");
  });

  it("rejects wrong regions dimensions", () => {
    const bad = { ...baseInput(), regions: [[0, 1], [1, 0]] };
    const { errors, puzzle } = validatePuzzleInput(bad);
    assert.equal(puzzle, null);
    assert.ok(errors.some((e) => e.includes('"regions" must have 9 rows')));
  });

  it("rejects region ids outside 0..8", () => {
    const regions = REGIONS.map((r) => r.slice());
    regions[0][0] = 9;
    const { errors, puzzle } = validatePuzzleInput({ ...baseInput(), regions });
    assert.equal(puzzle, null);
    assert.ok(errors.length > 0);
  });

  it("rejects missing region ids (only 8 distinct regions)", () => {
    const regions = REGIONS.map((r) => r.map((v) => (v === 8 ? 7 : v)));
    const { errors, puzzle } = validatePuzzleInput({ ...baseInput(), regions });
    assert.equal(puzzle, null);
    assert.ok(errors.some((e) => e.includes("exactly 9 distinct")));
  });

  it("rejects illegal initial symbols", () => {
    const initial = blankInitial();
    initial[4][4] = "Q";
    const { errors, puzzle } = validatePuzzleInput({ ...baseInput(), initial });
    assert.equal(puzzle, null);
    assert.ok(errors.length > 0);
  });

  it("normalizes X/x/c to ./C", () => {
    const initial = blankInitial();
    initial[0][0] = "x";
    initial[0][1] = "c";
    const { puzzle } = validatePuzzleInput({ ...baseInput(), initial });
    assert.equal(puzzle?.initial[0][0], ".");
    assert.equal(puzzle?.initial[0][1], "C");
  });

  it("accepts a valid palette and rejects a bad one", () => {
    const palette = ["#74C6C4", "#87A1C7", "#AC99DC", "#ECBDD0", "#C0E2AE", "#BCCEE2", "#D08BA8", "#EBD083", "#8DCCEC"];
    const ok = validatePuzzleInput({ ...baseInput(), palette });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.puzzle?.palette, palette);
    const bad = validatePuzzleInput({ ...baseInput(), palette: ["red", "#GGGGGG", "#12345", "#1234567", 7, null, "#abc", "#ABCDEF", "#000"] });
    assert.equal(bad.puzzle, null);
    assert.ok(bad.errors.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Solution validator
// ---------------------------------------------------------------------------

describe("validateSolution", () => {
  it("accepts the known-good solution", () => {
    const p = normalized(baseInput());
    assert.deepEqual(validateSolution(p, solutionGridFrom(KNOWN_CROWNS)), []);
  });

  it("detects a row with too few crowns", () => {
    const p = normalized(baseInput());
    const g = solutionGridFrom(KNOWN_CROWNS);
    g[0][0] = "."; // row 0 now has 1 crown
    const errs = validateSolution(p, g);
    assert.ok(errs.some((e) => e.includes("row 0 has 1 crowns")));
  });

  it("detects a column violation", () => {
    const p = normalized(baseInput());
    const g = solutionGridFrom(KNOWN_CROWNS);
    g[0][1] = "C"; // column 1 now has 3 crowns
    const errs = validateSolution(p, g);
    assert.ok(errs.some((e) => e.includes("column 1")));
  });

  it("detects orthogonally touching crowns", () => {
    const p = normalized(baseInput());
    const g = solutionGridFrom(KNOWN_CROWNS);
    g[0][1] = "C"; // touches (0,0) and (0,2)
    const errs = validateSolution(p, g);
    assert.ok(errs.some((e) => e.includes("touch orthogonally")));
  });

  it("detects diagonally touching crowns", () => {
    const p = normalized(baseInput());
    const g = Array.from({ length: 9 }, () => Array(9).fill("."));
    g[4][4] = "C";
    g[5][5] = "C";
    const errs = validateSolution(p, g);
    assert.ok(errs.some((e) => e.includes("touch diagonally")));
  });

  it("detects a region violation", () => {
    const p = normalized(baseInput());
    const g = solutionGridFrom(KNOWN_CROWNS);
    // Move a crown within its row: (0,0) is region 0, (0,1) is also region 0 -> still fine.
    // Instead move (1,4) [region 1] to (1,0) [region 0]: region 1 loses one, region 0 gains one.
    g[1][4] = ".";
    g[1][0] = "C";
    const errs = validateSolution(p, g);
    assert.ok(errs.some((e) => e.includes("region")));
  });
});

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

describe("solver", () => {
  it("solves the base puzzle with a fully valid explicit grid", () => {
    const res = solvePuzzle({ ...baseInput(), initial: blankInitial() });
    assert.equal(res.status, "solved");
    const sol = res.solution!;
    const crowns = res.crowns!;
    // Entire board filled explicitly, exactly 18 crowns
    assert.equal(sol.length, 9);
    for (const row of sol) {
      assert.equal(row.length, 9);
      for (const cell of row) assert.ok(cell === "C" || cell === ".");
    }
    assert.equal(crowns.length, 18);
    // Independent re-validation of every rule
    const p = normalized(baseInput());
    assert.deepEqual(validateSolution(p, sol), []);
  });

  it("respects pre-placed crowns and forced empties", () => {
    const initial = blankInitial();
    initial[0][0] = "C";
    initial[1][4] = "C";
    initial[8][7] = "C";
    initial[0][1] = "."; // forced empty next to a crown
    initial[4][4] = "X"; // alias for empty
    const res = solvePuzzle({ ...baseInput(), initial });
    assert.equal(res.status, "solved");
    const sol = res.solution!;
    assert.equal(sol[0][0], "C");
    assert.equal(sol[1][4], "C");
    assert.equal(sol[8][7], "C");
    const p = normalized({ ...baseInput(), initial });
    assert.deepEqual(validateSolution(p, sol), []);
  });

  it("reports unsolvable when a row is starved of cells", () => {
    const initial = blankInitial();
    for (let c = 1; c < 9; c++) initial[0][c] = "."; // row 0 can hold at most 1 crown, needs 2
    const res = solvePuzzle({ ...baseInput(), initial });
    assert.equal(res.status, "unsolvable");
    assert.equal(res.solution, null);
  });

  it("reports unsolvable for diagonally touching pre-placed crowns", () => {
    const initial = blankInitial();
    initial[4][4] = "C";
    initial[5][5] = "C";
    const res = solvePuzzle({ ...baseInput(), initial });
    assert.equal(res.status, "unsolvable");
  });

  it("reports unsolvable for three pre-placed crowns in one row", () => {
    const initial = blankInitial();
    initial[0][0] = "C";
    initial[0][4] = "C";
    initial[0][8] = "C";
    const res = solvePuzzle({ ...baseInput(), initial });
    assert.equal(res.status, "unsolvable");
  });

  it("reports invalid for malformed input", () => {
    const res = solvePuzzle({ size: 9, regions: [[0]] });
    assert.equal(res.status, "invalid");
    assert.ok(res.errors.length > 0);
  });

  it("solveAll honors the limit", () => {
    const p = normalized({ ...baseInput(), initial: blankInitial() });
    const one = solveAll(p, { limit: 1 });
    assert.equal(one.length, 1);
    assert.deepEqual(validateSolution(p, one[0].grid), []);
  });
});

describe("hints", () => {
  it("highlights a whole column and its only remaining queen candidate", () => {
    const initial = blankInitial();
    initial[0][0] = "C";
    for (let r = 1; r < 8; r++) initial[r][0] = ".";
    const hints = findHints(normalized({ ...baseInput(), initial }));
    const hint = hints.find((h) => h.kind === "queen" && h.scope === "column");
    assert.ok(hint);
    assert.equal(hint!.cells.length, 9);
    assert.deepEqual(hint!.decisiveCells, ["8,0"]);
  });

  it("highlights multiple cells ruled out by an existing queen", () => {
    const initial = blankInitial();
    initial[4][4] = "C";
    const hints = findHints(normalized({ ...baseInput(), initial }));
    const hint = hints.find((h) => h.scope === "neighbors" && h.kind === "cross");
    assert.ok(hint);
    assert.equal(hint!.decisiveCells.length, 8);
    assert.ok(hint!.cells.includes("4,4"));
    assert.equal(hints[0].method, "adjacency");
    assert.equal(hints[0].difficulty, 0);
    assert.match(hints[0].text, /R5C5/);
  });

  it("finds deductions that require combining several constraints", () => {
    const raw = JSON.parse(fs.readFileSync("public/examples/image-puzzle.json", "utf8")) as unknown;
    const checked = validatePuzzleInput(raw);
    assert.ok(checked.puzzle);
    const hints = findHints(checked.puzzle!);
    const complex = hints.find((hint) => hint.scope === "analysis");
    assert.ok(complex, "expected at least one solver-backed deduction");
    assert.doesNotMatch(complex!.text, /Advanced deduction/);
    assert.match(complex!.text, /no valid option|touch the queen/);
    for (let i = 1; i < hints.length; i++) {
      assert.ok(
        hints[i - 1].difficulty < hints[i].difficulty ||
          hints[i - 1].proofCost <= hints[i].proofCost,
        "hints should be ordered from easier to harder",
      );
    }
    const [r, c] = complex!.decisiveCells[0].split(",").map(Number);
    const impossibleValue = complex!.kind === "cross" ? "C" : ".";
    assert.equal(testAssumption(checked.puzzle!, r, c, impossibleValue), "unsatisfiable");
    const proof = testAssumptionDetailed(checked.puzzle!, r, c, impossibleValue);
    assert.ok(proof.witness, "solver-backed hints should expose a contradiction witness");
    assert.ok(proof.witness!.cells.length > 0);
  });
});

describe("editable marks", () => {
  it("cycles unmarked, cross, queen, and back to unmarked", () => {
    assert.equal(nextMark("?"), ".");
    assert.equal(nextMark("."), "C");
    assert.equal(nextMark("C"), "?");
  });
});

// ---------------------------------------------------------------------------
// Puzzle generation
// ---------------------------------------------------------------------------

describe("generatePuzzle", () => {
  it("produces a valid solvable 9x9 puzzle", () => {
    const puzzle = generatePuzzle(9, 2);
    assert.equal(puzzle.size, 9);
    assert.equal(puzzle.regions.length, 9);
    assert.equal(puzzle.regions[0].length, 9);
    assert.equal(puzzle.crownsPerRow, 2);
    assert.equal(puzzle.initial.flat().every((c) => c === "?"), true);

    const solutions = solveAll(puzzle, { limit: 1 });
    assert.equal(solutions.length, 1);
    assert.deepEqual(validateSolution(puzzle, solutions[0].grid), []);
  });

  it("generates different region layouts across calls", () => {
    const results = new Set<string>();
    // Run several times; at least 2 out of 10 should be unique
    for (let i = 0; i < 10; i++) {
      results.add(JSON.stringify(generatePuzzle(9, 2).regions));
    }
    assert.ok(results.size > 1, "should produce different layouts across calls");
  });

  it("round-trips through solvePuzzle (null palette is accepted)", () => {
    const puzzle = generatePuzzle(9, 2);
    assert.equal(puzzle.palette, null);
    const result = solvePuzzle(puzzle);
    assert.equal(result.status, "solved");
    assert.ok(result.solution);
  });

  it("produces exactly N regions of size N", () => {
    const puzzle = generatePuzzle(9, 2);
    const counts = new Map<number, number>();
    for (const row of puzzle.regions) {
      for (const id of row) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    assert.equal(counts.size, 9);
    for (const [, count] of counts) {
      assert.equal(count, 9);
    }
  });
});
