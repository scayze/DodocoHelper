import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validatePuzzleInput, validateSolution } from "../src/games/crowns/validator.js";
import { solveAll, solvePuzzle, testAssumption, testAssumptionDetailed, buildInitialState, tryPlaceCrown, markCrown, propagate, collectPropagateChanges, solveByDeduction, stateToGrid, deduceRegionFit, deduceBand, deducePointing, deduceHall, bandAnalyze, K, E } from "../src/games/crowns/solver.js";
import { findHints, stepToHint } from "../src/games/crowns/hints.js";
import { nextMark } from "../src/games/crowns/marks.js";
import { generatePuzzle, generateRegions } from "../src/games/crowns/generator.js";
import { mulberry32 } from "../src/games/daily.js";
import type { NormalizedPuzzle } from "../src/games/crowns/types.js";
import { CROWN, EMPTY } from "../src/games/crowns/types.js";

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
  const { errors, puzzle } = validatePuzzleInput(input);
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
    const raw = JSON.parse(fs.readFileSync("src/games/crowns/fixtures/ScreenshotFixtures/image123.expected.json", "utf8")) as unknown;
    const checked = validatePuzzleInput(raw);
    assert.ok(checked.puzzle);
    const hints = findHints(checked.puzzle!);
    const complex = hints.find((hint) => hint.scope === "analysis");
    assert.ok(complex, "expected at least one solver-backed deduction");
    assert.doesNotMatch(complex!.text, /Advanced deduction/);
    assert.match(complex!.text, /no valid way|touch/);
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
// Human-style deduction engine (solver.ts)
// ---------------------------------------------------------------------------

function loadBoard(p: NormalizedPuzzle, state: { grid: number[] }): void {
  for (let r = 0; r < p.size; r++) {
    for (let c = 0; c < p.size; c++) {
      if (p.initial[r][c] === EMPTY) state.grid[r * p.size + c] = E;
    }
  }
}

describe("deduction engine", () => {
  it("crosses all 8 neighbours of a crown", () => {
    const p = normalized({ ...baseInput(), initial: blankInitial() });
    const { state, tg } = buildInitialState(p);
    assert.ok(markCrown(state, tg, 4, 4));
    const before = state.grid.slice();
    assert.equal(propagate(state, tg), null);
    const steps = collectPropagateChanges(state, before);
    assert.equal(steps.filter((s) => s.to === E).length, 8);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        assert.equal(state.grid[(4 + dr) * 9 + (4 + dc)], E);
      }
    }
  });

  it("forces the last remaining crown of a column", () => {
    const p = normalized({ ...baseInput(), initial: blankInitial() });
    const { state, tg } = buildInitialState(p);
    assert.ok(markCrown(state, tg, 0, 0));
    for (let r = 1; r < 8; r++) state.grid[r * 9 + 0] = E;
    const before = state.grid.slice();
    assert.equal(propagate(state, tg), null);
    const steps = collectPropagateChanges(state, before);
    assert.ok(steps.some((s) => s.to === K && s.r === 8 && s.c === 0), "column 0 must force (8,0)");
  });

  it("can fully deduce the blank fixture board using advanced rules", () => {
    const p = normalized({ ...baseInput(), initial: blankInitial() });
    const { state, tg } = buildInitialState(p);
    const res = solveByDeduction(state, tg, false);
    assert.ok(res.solved, "blank REGIONS board must be solvable by deduction");
    assert.equal(res.contradiction, false);
    assert.ok(res.steps.length > 0);
    assert.deepEqual(validateSolution(p, stateToGrid(state).grid), []);
  });

  it("reports a contradiction when a state cannot satisfy a unit", () => {
    const p = normalized({ ...baseInput(), initial: blankInitial() });
    const { state, tg } = buildInitialState(p);
    // Starve column 0: cross out all but one cell.
    for (let r = 1; r < 9; r++) state.grid[r * 9 + 0] = E;
    const res = solveByDeduction(state, tg, false);
    assert.ok(res.contradiction);
    assert.equal(res.solved, false);
  });

  it("fully revealed boards are solved by plain propagation", () => {
    const p = normalized({ ...baseInput(), initial: solutionGridFrom(KNOWN_CROWNS) });
    const { state, tg } = buildInitialState(p);
    loadBoard(p, state);
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (p.initial[r][c] === CROWN) assert.ok(markCrown(state, tg, r, c));
      }
    }
    const res = solveByDeduction(state, tg, false);
    assert.ok(res.solved, "fully revealed board must be human-solvable");
    assert.deepEqual(validateSolution(p, stateToGrid(state).grid), []);
  });

  it("region-fit crosses a region centre that can never hold a queen", () => {
    // Region 0 is a plus around (2,2); it needs 2 queens that must never
    // touch, so the centre blocks every option. Built directly (size 5 sits
    // below the playable limit) because we only exercise the rule itself.
    const regions = [
      [1, 1, 1, 1, 1],
      [3, 3, 0, 4, 4],
      [3, 0, 0, 0, 4],
      [3, 3, 0, 4, 4],
      [2, 2, 2, 2, 2],
    ];
    const puzzle: NormalizedPuzzle = {
      size: 5,
      crownsPerRow: 2,
      crownsPerColumn: 2,
      crownsPerRegion: 2,
      regions,
      regionCount: 5,
      initial: Array.from({ length: 5 }, () => Array(5).fill("?")),
      palette: null,
    };
    const { state, tg } = buildInitialState(puzzle);
    const res = deduceRegionFit(state, tg);
    assert.equal(res.witness, null);
    const crossed = new Set(res.steps.filter((s) => s.to === E).map((s) => `${s.r},${s.c}`));
    assert.ok(crossed.has("2,2"), "the plus centre must be crossed");
    assert.ok(res.steps.every((s) => s.to === E), "no forced queen in the plus");
  });

  it("region-fit and band-cover marks are sound (verified against exact search)", () => {
    const toInitial = (state: { n: number; grid: number[] }): string[][] => {
      const out: string[][] = [];
      for (let r = 0; r < state.n; r++) {
        const row: string[] = [];
        for (let c = 0; c < state.n; c++) {
          row.push(state.grid[r * state.n + c] === K ? CROWN : state.grid[r * state.n + c] === E ? EMPTY : "?");
        }
        out.push(row);
      }
      return out;
    };
    let verified = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const regions = generateRegions(6, 1, mulberry32(9000 + seed));
      if (!regions) continue;
      const rand = mulberry32(seed * 31);
      const initial = Array.from({ length: 6 }, () => Array(6).fill("?"));
      const order: Array<[number, number]> = [];
      for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) order.push([r, c]);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      let crowns = 0;
      for (const [r, c] of order) {
        if (crowns >= 3) break;
        let touching = false;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < 6 && nc >= 0 && nc < 6 && initial[nr][nc] === CROWN) touching = true;
        }
        if (touching) continue;
        // Each unit holds at most one queen here (1 queen per row/col/region).
        if (initial.some((row) => row.includes(CROWN) && row === initial[r])) continue;
        const sameCol = Array.from({ length: 6 }, (_, rr) => initial[rr][c]).includes(CROWN);
        const sameReg = Array.from({ length: 36 }, (_, i) => {
          const rr = Math.floor(i / 6);
          const cc = i % 6;
          return regions[rr][cc] === regions[r][c] ? initial[rr][cc] : undefined;
        }).includes(CROWN);
        if (!sameCol && !sameReg) {
          initial[r][c] = CROWN;
          crowns++;
        }
      }
      for (const [r, c] of order.slice(0, 6)) {
        if (initial[r][c] === "?") initial[r][c] = EMPTY;
      }
      const checked = validatePuzzleInput({ size: 6, crownsPerRow: 1, crownsPerColumn: 1, crownsPerRegion: 1, regions, initial });
      if (!checked.puzzle) continue;
      const p = checked.puzzle;
      const { state, tg } = buildInitialState(p);
      for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) {
        if (initial[r][c] === EMPTY) state.grid[r * 6 + c] = E;
        if (initial[r][c] === CROWN) assert.ok(markCrown(state, tg, r, c));
      }
      const kinds = [
        { rule: "region-fit", steps: deduceRegionFit(state, tg).steps },
        { rule: "band-cover", steps: deduceBand(state, tg).steps },
        { rule: "pointing", steps: deducePointing(state, tg) },
        { rule: "hall", steps: deduceHall(state, tg).steps },
      ];
      const premise = validatePuzzleInput({ size: 6, crownsPerRow: 1, crownsPerColumn: 1, crownsPerRegion: 1, regions, initial: toInitial(state) });
      assert.ok(premise.puzzle);
      for (const { rule, steps } of kinds) {
        for (const s of steps) {
          const opposite = s.to === K ? EMPTY : CROWN;
          const res = testAssumption(premise.puzzle!, s.r, s.c, opposite);
          if (res === "unknown") continue; // budget-limited search doesn't disprove anything
          assert.equal(res, "unsatisfiable", `${rule} mark at (${s.r},${s.c}) must be forced`);
          verified++;
        }
      }
    }
    assert.ok(verified > 0, "the new rules must actually fire on some case");
  });
});

// ---------------------------------------------------------------------------
// Harder human deductions: pointing, dynamic hall, gapped band pairs
// ---------------------------------------------------------------------------
describe("harder human deductions", () => {
  // 5x5, 1 crown per row/column/region.
  // Solution crowns: (0,0), (1,2), (2,4), (3,1), (4,3).
  const regions5 = [
    [0, 0, 1, 1, 1],
    [0, 2, 1, 1, 1],
    [2, 2, 2, 2, 2],
    [3, 3, 3, 3, 4],
    [3, 3, 4, 4, 4],
  ];
  const blank5 = () => Array.from({ length: 5 }, () => Array(5).fill("?"));
  const load = (initial: string[][]) => {
    const checked = validatePuzzleInput({ size: 5, crownsPerRow: 1, crownsPerColumn: 1, crownsPerRegion: 1, regions: regions5, initial });
    assert.deepEqual(checked.errors, []);
    assert.ok(checked.puzzle);
    const { state, tg } = buildInitialState(checked.puzzle!);
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
      if (initial[r][c] === EMPTY) state.grid[r * 5 + c] = E;
      if (initial[r][c] === CROWN) assert.ok(markCrown(state, tg, r, c));
    }
    return { puzzle: checked.puzzle!, state, tg };
  };
  const verifySound = (puzzle: NormalizedPuzzle, steps: Array<{ r: number; c: number; to: number }>, rule: string) => {
    for (const s of steps) {
      const opposite = s.to === K ? EMPTY : CROWN;
      const res = testAssumption(puzzle, s.r, s.c, opposite);
      if (res === "unknown") continue;
      assert.equal(res, "unsatisfiable", `${rule} mark at (${s.r},${s.c}) must be forced`);
    }
  };

  it("pointing and dynamic hall fire on effective (not geometric) containment", () => {
    const initial = blank5();
    initial[1][0] = EMPTY; // region 1's only row-2 cell; solution crown (0,0) survives
    const { puzzle, state, tg } = load(initial);
    assert.ok(solveAll(puzzle, { limit: 1 }).length > 0, "premise must stay solvable");

    // Region 1's remaining placements are all in row 1 and row 1 needs exactly
    // one queen: the rest of row 1 is dead.
    const pointing = deducePointing(state, tg);
    const pCells = new Set(pointing.map((s) => `${s.r},${s.c}`));
    assert.ok(pCells.has("0,2") && pCells.has("0,3") && pCells.has("0,4"), "pointing must cross row 1 outside region 1");
    assert.ok(pointing.every((s) => s.to === E && s.rule === "pointing"));
    verifySound(puzzle, pointing, "pointing");

    // No region is GEOMETRICALLY contained in row 1 (region 1 leaks to row 2
    // on the map), so the classic static hall is silent — the dynamic rule
    // fires on the effective footprint instead.
    const hall = deduceHall(state, tg);
    assert.equal(hall.witness, null);
    assert.ok(hall.steps.some((s) => s.r === 0 && s.c === 2 && s.to === E), "dynamic hall must cross (0,2)");
    verifySound(puzzle, hall.steps, "hall");
  });

  it("pointing respects the count-equality guard (no cross without it)", () => {
    const initial = blank5();
    initial[1][0] = EMPTY;
    initial[0][0] = CROWN; // solution crown: region 1 needs 0, row 1 needs 0
    const { puzzle, state, tg } = load(initial);
    assert.ok(solveAll(puzzle, { limit: 1 }).length > 0, "premise must stay solvable");
    const pointing = deducePointing(state, tg);
    // Region 1 is satisfied and row 1 is full: nothing left to claim there.
    assert.ok(pointing.every((s) => s.r !== 0), "no pointing step may touch the full row");
    // But the mirror still fires: row 3's only region is region 3, which needs
    // exactly row 3's one slot, so region 3's cell (1,1) is dead.
    assert.ok(pointing.some((s) => s.r === 1 && s.c === 1 && s.to === E), "line-to-region mirror must cross (1,1)");
    verifySound(puzzle, pointing, "pointing");
  });

  it("a gapped row pair locks (column bands ride the same machinery)", () => {
    const initial = blank5();
    // Eliminate every in-band cell of region 2 from rows {0,2} without
    // touching the solution: rows {0,2} then touch exactly regions {1,3}.
    initial[0][1] = EMPTY;
    initial[0][2] = EMPTY;
    initial[0][3] = EMPTY;
    initial[0][4] = EMPTY;
    const { puzzle, state, tg } = load(initial);
    assert.ok(solveAll(puzzle, { limit: 1 }).length > 0, "premise must stay solvable");
    // The gapped pair is tight and forces the row-1 queen at (0,0).
    const pair = bandAnalyze(state, tg, [0, 2], "row");
    assert.equal(pair.witness, null);
    const forced = pair.steps.find((s) => s.r === 0 && s.c === 0);
    assert.ok(forced && forced.to === K, "gapped pair must force queen (0,0)");
    assert.ok(forced.reason.includes("1 and 3"), "reason must name the gapped rows");
    verifySound(puzzle, pair.steps, "band-cover");
    // End to end the band cascade surfaces the same forced queen.
    const endToEnd = deduceBand(state, tg);
    assert.equal(endToEnd.witness, null);
    assert.ok(endToEnd.steps.some((s) => s.r === 0 && s.c === 0 && s.to === K));
    verifySound(puzzle, endToEnd.steps, "band-cover");
  });
});

// ---------------------------------------------------------------------------
// Hint trust fixes: cited crowns, named units, fitting highlights
// ---------------------------------------------------------------------------
describe("hint trust", () => {
  const regions5 = [
    [0, 0, 1, 1, 1],
    [0, 2, 1, 1, 1],
    [2, 2, 2, 2, 2],
    [3, 3, 3, 3, 4],
    [3, 3, 4, 4, 4],
  ];
  const blank5 = () => Array.from({ length: 5 }, () => Array(5).fill("?"));
  const norm5 = (initial: string[][]): NormalizedPuzzle => {
    const checked = validatePuzzleInput({ size: 5, crownsPerRow: 1, crownsPerColumn: 1, crownsPerRegion: 1, regions: regions5, initial });
    assert.deepEqual(checked.errors, []);
    assert.ok(checked.puzzle);
    return checked.puzzle!;
  };
  const inBounds = (puzzle: NormalizedPuzzle, position: string) => {
    const [r, c] = position.split(",").map(Number);
    return r >= 0 && r < puzzle.size && c >= 0 && c < puzzle.size;
  };
  /** Fitting-highlight invariants for every hint on the board. */
  const checkInvariants = (puzzle: NormalizedPuzzle, hints: ReturnType<typeof findHints>) => {
    for (const h of hints) {
      for (const d of h.decisiveCells) assert.ok(h.cells.includes(d), `${h.method}: decisive ${d} must be highlighted`);
      for (const cell of h.cells) assert.ok(inBounds(puzzle, cell), `${h.method}: highlight ${cell} out of bounds`);
      assert.ok(h.cells.length <= 2 * puzzle.size, `${h.method}: context of ${h.cells.length} washes the board`);
      if (h.method === "adjacency") {
        const [pr, pc] = h.cells[0].split(",").map(Number);
        assert.equal(puzzle.initial[pr][pc], "C", `adjacency parent ${h.cells[0]} must be a placed crown`);
      }
    }
  };

  it("never cites a deduced crown as an adjacency parent", () => {
    // Row 1 has a single unknown: propagation deduces (but the player never
    // placed) the queen at R1C1. Its neighbours must not be blamed on it.
    const initial = blank5();
    initial[0][1] = "."; initial[0][2] = "."; initial[0][3] = "."; initial[0][4] = ".";
    const puzzle = norm5(initial);
    const hints = findHints(puzzle, false);
    assert.ok(hints.length > 0);
    for (const h of hints) {
      if (h.method !== "adjacency") continue;
      const [pr, pc] = h.cells[0].split(",").map(Number);
      assert.equal(puzzle.initial[pr][pc], "C", `phantom parent ${h.cells[0]}: ${h.text}`);
    }
    checkInvariants(puzzle, hints);
  });

  it("names the unit in 1d-fit, critical, region-fit and hall reasons", () => {
    const puzzle = norm5(blank5());
    const { state, tg } = buildInitialState(puzzle);
    const hall = deduceHall(state, tg);
    assert.ok(hall.steps.length > 0);
    assert.ok(/[Rr]ows? 1/.test(hall.steps[0].reason), `hall must name its rows: ${hall.steps[0].reason}`);
    const hints = findHints(puzzle, false);
    assert.ok(hints.length > 0);
    for (const h of hints) {
      if (h.method === "critical" || h.method === "1d-fit") {
        assert.ok(/row \d|column \d|region \d/.test(h.text), `${h.method} must name a unit: ${h.text}`);
      }
      if (h.method === "region-fit") {
        assert.ok(/region \d/.test(h.text), `region-fit must name its region: ${h.text}`);
      }
      if (h.method === "hall") {
        assert.ok(/[Rr]ows? \d/.test(h.text), `hall must name its rows: ${h.text}`);
      }
    }
    checkInvariants(puzzle, hints);
  });

  it("passes solver reasons and contexts through"
    + " (column bands never say rows)", () => {
    const puzzle = norm5(blank5());
    const colReason = "No way to fill columns 2 and 4 together uses this cell";
    const bandHint = stepToHint(puzzle, { r: 0, c: 1, to: E, rule: "band-cover", reason: colReason, context: ["0,1", "0,3", "2,1"] });
    assert.ok(bandHint);
    assert.equal(bandHint!.text, colReason);
    assert.ok(!/rows?/i.test(bandHint!.text), "column band text must not mention rows");
    assert.deepEqual(new Set(bandHint!.cells), new Set(["0,1", "0,3", "2,1"]));
    const critHint = stepToHint(puzzle, { r: 1, c: 1, to: E, rule: "critical", reason: "Placing a queen here would starve neighboring row 3, leaving no valid way to fill it.", context: ["2,0", "2,1"] });
    assert.ok(critHint);
    assert.ok(critHint!.text.includes("row 3"));
    // Decisive cell is unioned into a context that lacks it.
    assert.deepEqual(new Set(critHint!.cells), new Set(["2,0", "2,1", "1,1"]));
    assert.deepEqual(critHint!.decisiveCells, ["1,1"]);
  });

  it("keeps highlights fitting on solution-consistent mid-game boards", () => {
    // Solution crowns: (0,0), (1,2), (2,4), (3,1), (4,3). Marks below agree.
    const marks: Array<[number, number, string]> = [
      [1, 0, "."], [0, 1, "."], [3, 3, "."], [4, 4, "."], [0, 0, "C"],
    ];
    const initial = blank5();
    for (const [r, c, v] of marks) initial[r][c] = v;
    const puzzle = norm5(initial);
    assert.ok(solveAll(puzzle, { limit: 1 }).length > 0, "premise must stay solvable");
    checkInvariants(puzzle, findHints(puzzle, false));
    checkInvariants(puzzle, findHints(puzzle, true));
  });
});

// ---------------------------------------------------------------------------
// Puzzle generation
// ---------------------------------------------------------------------------

describe("generatePuzzle", () => {
  it("produces a blank, human-deductible 9x9 puzzle with a unique solution", () => {
    const puzzle = generatePuzzle(9, 2, 1200, mulberry32(42));
    assert.equal(puzzle.size, 9);
    assert.equal(puzzle.regions.length, 9);
    assert.equal(puzzle.regions[0].length, 9);
    assert.equal(puzzle.crownsPerRow, 2);
    assert.ok(
      puzzle.initial.flat().every((c) => c === "?" || c === "C"),
      "generated boards must not prefill crosses",
    );

    const { state, tg } = buildInitialState(puzzle);
    for (let r = 0; r < puzzle.size; r++) {
      for (let c = 0; c < puzzle.size; c++) {
        if (puzzle.initial[r][c] === CROWN) assert.ok(tryPlaceCrown(state, tg, r, c));
      }
    }
    assert.ok(solveByDeduction(state, tg, false).solved, "generated boards must be solvable by pure deduction");

    const solutions = solveAll(puzzle, { limit: 2 });
    assert.equal(solutions.length, 1, "generated boards must have a unique solution");
    assert.deepEqual(validateSolution(puzzle, solutions[0].grid), []);
  });

  it("generates different region layouts across calls", () => {
    const results = new Set<string>();
    // Several calls; they must not all be identical.
    for (let i = 0; i < 4; i++) {
      results.add(JSON.stringify(generatePuzzle(9, 2, 1200, mulberry32([1, 2, 42, 99][i])).regions));
    }
    assert.ok(results.size > 1, "should produce different layouts across calls");
  });

  it("can generate a blank human-deductible board with a unique solution", () => {
    const easy = generatePuzzle(9, 2, 1200, mulberry32(7));
    assert.equal(solveAll(easy, { limit: 2 }).length, 1, "unique solution expected");
    assert.ok(
      easy.initial.flat().every((c) => c === "?"),
      "generated boards are never prefilled with crowns",
    );
    const { state, tg } = buildInitialState(easy);
    for (let r = 0; r < easy.size; r++) {
      for (let c = 0; c < easy.size; c++) {
        if (easy.initial[r][c] === CROWN) assert.ok(tryPlaceCrown(state, tg, r, c));
      }
    }
    assert.ok(solveByDeduction(state, tg, false).solved, "board must be human-solvable");
  });

  it("round-trips through solvePuzzle (null palette is accepted)", () => {
    const puzzle = generatePuzzle(9, 2, 1200, mulberry32(99));
    assert.equal(puzzle.palette, null);
    const result = solvePuzzle(puzzle);
    assert.equal(result.status, "solved");
    assert.ok(result.solution);
  });

  it("is deterministic for the same seeded random stream", () => {
    const first = generatePuzzle(9, 2, 1200, mulberry32(123456));
    const second = generatePuzzle(9, 2, 1200, mulberry32(123456));
    assert.deepEqual(second.regions, first.regions);
  });

  it("produces connected regions with varied sizes", () => {
    const puzzle = generatePuzzle(9, 2, 1200, mulberry32(1));
    const counts = new Map<number, number>();
    for (const row of puzzle.regions) {
      for (const id of row) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    assert.equal(counts.size, 9);
    assert.equal([...counts.values()].reduce((sum, count) => sum + count, 0), 81);
    assert.ok(new Set(counts.values()).size > 1, "regions should have varied sizes");
    assert.ok(Math.min(...counts.values()) >= 5, "regions should not be too small");

    for (const [region] of counts) {
      const cells: Array<[number, number]> = [];
      for (let r = 0; r < puzzle.size; r++) {
        for (let c = 0; c < puzzle.size; c++) {
          if (puzzle.regions[r][c] === region) cells.push([r, c]);
        }
      }
      const seen = new Set([`${cells[0][0]},${cells[0][1]}`]);
      const queue = [cells[0]];
      while (queue.length > 0) {
        const [r, c] = queue.shift()!;
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nr = r + dr;
          const nc = c + dc;
          const key = `${nr},${nc}`;
          if (nr >= 0 && nr < puzzle.size && nc >= 0 && nc < puzzle.size &&
              puzzle.regions[nr][nc] === region && !seen.has(key)) {
            seen.add(key);
            queue.push([nr, nc]);
          }
        }
      }
      assert.equal(seen.size, cells.length, `region ${region} must be connected`);
    }
  });
});
