import type { NormalizedPuzzle } from "./types.js";
import { CROWN } from "./types.js";
import { buildInitialState, markCrown, propagate, collectPropagateChanges, findForcedSteps, findSearchStep, K, E, type Step } from "./solver.js";

const idx = (n: number, r: number, c: number) => r * n + c;

/** If the step cell sits next to a crown (in the propagated state), return its key. */
function adjacencyParent(state: { n: number; grid: number[] }, r: number, c: number): string | null {
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= state.n || nc < 0 || nc >= state.n) continue;
      if (state.grid[idx(state.n, nr, nc)] === K) return key(nr, nc);
    }
  }
  return null;
}

export type HintKind = "queen" | "cross";
export type HintScope = "row" | "column" | "region" | "neighbors" | "analysis";
export type HintMethod = "adjacency" | "unit-complete" | "unit-forced" | "1d-fit" | "critical" | "region-fit" | "hall" | "band-cover" | "contradiction";
export type HintDifficulty = "Trivial" | "Easy" | "Intermediate" | "Hard" | "Expert";

export interface Hint {
  kind: HintKind;
  scope: HintScope;
  text: string;
  cells: string[];
  decisiveCells: string[];
  method: HintMethod;
  difficulty: number;
  proofCost: number;
  difficultyLabel: HintDifficulty;
}

const key = (r: number, c: number) => `${r},${c}`;

function cellName(position: string): string {
  const [r, c] = position.split(",").map(Number);
  return `R${r + 1}C${c + 1}`;
}

function unitName(scope: "row" | "column" | "region", unit: number): string {
  return `${scope} ${unit + 1}`;
}

function unitQuota(puzzle: NormalizedPuzzle, scope: "row" | "column" | "region"): number {
  if (scope === "row") return puzzle.crownsPerRow;
  if (scope === "column") return puzzle.crownsPerColumn;
  return puzzle.crownsPerRegion;
}

function unitCells(puzzle: NormalizedPuzzle, scope: HintScope, unit: number): string[] {
  const cells: string[] = [];
  for (let r = 0; r < puzzle.size; r++) {
    for (let c = 0; c < puzzle.size; c++) {
      if (
        (scope === "row" && r === unit) ||
        (scope === "column" && c === unit) ||
        (scope === "region" && puzzle.regions[r][c] === unit)
      )
        cells.push(key(r, c));
    }
  }
  return cells;
}

function placedInUnit(puzzle: NormalizedPuzzle, scope: HintScope, unit: number): number {
  return unitCells(puzzle, scope, unit).filter((position) => {
    const [r, c] = position.split(",").map(Number);
    return puzzle.initial[r][c] === CROWN;
  }).length;
}

function analysisContext(puzzle: NormalizedPuzzle, r: number, c: number): string[] {
  const cells = new Set<string>();
  for (const position of unitCells(puzzle, "row", r)) cells.add(position);
  for (const position of unitCells(puzzle, "column", c)) cells.add(position);
  for (const position of unitCells(puzzle, "region", puzzle.regions[r][c])) cells.add(position);
  return [...cells];
}

// ---------------------------------------------------------------------------
// Build hints from deduction steps
// ---------------------------------------------------------------------------

function stepToHint(puzzle: NormalizedPuzzle, step: Step): Hint | null {
  const { r, c, to, rule, reason } = step;
  const position = key(r, c);

  switch (rule) {
    case "propagate": {
      // A sealed cross from a completed unit. (Adjacency crosses are grouped
      // into per-queen hints in findHints and never reach this switch.)
      if (to === E) {
        for (const scope of ["row", "column", "region"] as const) {
          const unit = scope === "row" ? r : scope === "column" ? c : puzzle.regions[r][c];
          const quota = unitQuota(puzzle, scope);
          if (placedInUnit(puzzle, scope, unit) >= quota) {
            const allCells = unitCells(puzzle, scope, unit);
            return {
              kind: "cross",
              scope,
              method: "unit-complete",
              difficulty: 1,
              proofCost: 0,
              difficultyLabel: "Easy",
              text: `${unitName(scope, unit)} already has its ${quota} queens. Cross out the remaining unresolved cells.`,
              cells: allCells,
              decisiveCells: allCells.filter((p) => {
                const [rr, cc] = p.split(",").map(Number);
                return puzzle.initial[rr][cc] === "?";
              }),
            };
          }
        }
      }
      return null;
    }

    case "unit-forced": {
      for (const scope of ["row", "column", "region"] as const) {
        const unit = scope === "row" ? r : scope === "column" ? c : puzzle.regions[r][c];
        const quota = unitQuota(puzzle, scope);
        const need = quota - placedInUnit(puzzle, scope, unit);
        if (need <= 0) continue;
        const allCells = unitCells(puzzle, scope, unit);
        const unknowns = allCells.filter((p) => {
          const [rr, cc] = p.split(",").map(Number);
          return puzzle.initial[rr][cc] === "?";
        });
        // Only the unit where this cell is one of exactly the required candidates forces it.
        if (unknowns.length !== need || !unknowns.includes(position)) continue;
        return {
          kind: "queen",
          scope,
          method: "unit-forced",
          difficulty: 2,
          proofCost: 0,
          difficultyLabel: "Easy",
          text: `${unitName(scope, unit)} needs ${need} more ${need === 1 ? "queen" : "queens"}. Its only candidates are ${unknowns.map(cellName).join(", ")}, so ${cellName(position)} must be a queen.`,
          cells: allCells,
          decisiveCells: [position],
        };
      }
      return null;
    }

    case "1d-fit": {
      const context = analysisContext(puzzle, r, c);
      return {
        kind: to === K ? "queen" : "cross",
        scope: "analysis",
        method: "1d-fit",
        difficulty: 3,
        proofCost: 0,
        difficultyLabel: "Intermediate",
        text: to === K
          ? `The remaining empty pattern forces a queen at ${cellName(position)}.`
          : `The remaining empty pattern rules out ${cellName(position)}.`,
        cells: context,
        decisiveCells: [position],
      };
    }

    case "critical": {
      const context = analysisContext(puzzle, r, c);
      return {
        kind: "cross",
        scope: "analysis",
        method: "critical",
        difficulty: 5,
        proofCost: 0,
        difficultyLabel: "Intermediate",
        text: `Placing a queen at ${cellName(position)} would block too many cells in a neighboring unit, leaving no valid way to fill it.`,
        cells: context,
        decisiveCells: [position],
      };
    }

    case "region-fit": {
      const context = analysisContext(puzzle, r, c);
      return {
        kind: to === K ? "queen" : "cross",
        scope: "analysis",
        method: "region-fit",
        difficulty: 4,
        proofCost: 0,
        difficultyLabel: "Intermediate",
        text: to === K
          ? `Every possible way to place this region's remaining queens includes ${cellName(position)}, so it must be a queen.`
          : `No way to place this region's remaining queens uses ${cellName(position)}, so cross it out.`,
        cells: context,
        decisiveCells: [position],
      };
    }

    case "hall": {
      const context = analysisContext(puzzle, r, c);
      return {
        kind: "cross",
        scope: "analysis",
        method: "hall",
        difficulty: 6,
        proofCost: 0,
        difficultyLabel: "Hard",
        text: reason,
        cells: context,
        decisiveCells: [position],
      };
    }

    case "band-cover": {
      const context = analysisContext(puzzle, r, c);
      return {
        kind: to === K ? "queen" : "cross",
        scope: "analysis",
        method: "band-cover",
        difficulty: 7,
        proofCost: 0,
        difficultyLabel: "Hard",
        text: to === K
          ? `Every way to fill the surrounding rows together includes ${cellName(position)}, so it must be a queen.`
          : `No way to fill the surrounding rows together uses ${cellName(position)}, so cross it out.`,
        cells: context,
        decisiveCells: [position],
      };
    }

    case "search": {
      const context = analysisContext(puzzle, r, c);
      return {
        kind: to === K ? "queen" : "cross",
        scope: "analysis",
        method: "contradiction",
        difficulty: 10,
        proofCost: 1,
        difficultyLabel: "Expert",
        text: to === K
          ? `Leaving ${cellName(position)} empty would leave no valid way to finish the puzzle, so it must contain a queen.`
          : `Placing a queen at ${cellName(position)} would leave no valid way to finish the puzzle.`,
        cells: context,
        decisiveCells: [position],
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public hint finder
// ---------------------------------------------------------------------------

/** Find all applicable hints on the current player-visible board. */
export function findHints(puzzle: NormalizedPuzzle, allowSearch = true): Hint[] {
  const hints: Hint[] = [];
  const seen = new Set<string>();
  const add = (hint: Hint) => {
    const id = `${hint.kind}:${hint.scope}:${hint.decisiveCells.join(";")}`;
    if (!seen.has(id)) {
      seen.add(id);
      hints.push(hint);
    }
  };

  const { state, tg } = buildInitialState(puzzle);
  const n = state.n;

  // Load the player's marks. Crosses are set directly; crowns are marked
  // without touching neighbours so that adjacency is inferred by propagate.
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (puzzle.initial[r][c] === ".") state.grid[idx(n, r, c)] = E;
    }
  }
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (puzzle.initial[r][c] === CROWN && !markCrown(state, tg, r, c)) return []; // contradictory
    }
  }

  // --- Propagate ---
  const before = state.grid.slice();
  const witness = propagate(state, tg);
  if (witness) return []; // contradictory
  const propSteps = collectPropagateChanges(state, before);

  // Group adjacency crosses by their parent crown so one hint shows every
  // cell a single queen rules out at once.
  const adjacency = new Map<string, string[]>();
  const nonAdjacency: Step[] = [];
  for (const step of propSteps) {
    if (step.to === E) {
      const parent = adjacencyParent(state, step.r, step.c);
      if (parent) {
        const list = adjacency.get(parent) ?? [];
        list.push(key(step.r, step.c));
        adjacency.set(parent, list);
        continue;
      }
    }
    nonAdjacency.push(step);
  }
  for (const [parent, cells] of adjacency) {
    add({
      kind: "cross",
      scope: "neighbors",
      method: "adjacency",
      difficulty: 0,
      proofCost: 0,
      difficultyLabel: "Trivial",
      text: `The queen at ${cellName(parent)} touches ${cells.map(cellName).join(", ")}. Queens cannot touch, even diagonally, so cross ${cells.length === 1 ? "it" : "them"} out.`,
      cells: [parent, ...cells],
      decisiveCells: cells,
    });
  }
  for (const step of nonAdjacency) {
    const hint = stepToHint(puzzle, step);
    if (hint) add(hint);
  }
  if (hints.length > 0) return hints.sort((a, b) => a.difficulty - b.difficulty);

  // --- Advanced deduction rules (1d-fit / critical / region-fit / hall / band-cover) ---
  const forced = findForcedSteps(state, tg);
  if (forced && forced.steps.length > 0) {
    for (const step of forced.steps) {
      const hint = stepToHint(puzzle, step);
      if (hint) add(hint);
    }
    if (hints.length > 0) return hints.sort((a, b) => a.difficulty - b.difficulty);
  }

  // --- Search fallback ---
  if (allowSearch) {
    const searchStep = findSearchStep(state, tg, 5000);
    if (searchStep) {
      const hint = stepToHint(puzzle, searchStep);
      if (hint) add(hint);
    }
  }

  return hints.sort((a, b) => a.difficulty - b.difficulty);
}
