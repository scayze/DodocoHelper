import type { NormalizedPuzzle } from "./types.js";
import { testAssumptionDetailed } from "./solver.js";

export type HintKind = "queen" | "cross";
export type HintScope = "row" | "column" | "region" | "neighbors" | "analysis";
export type HintMethod = "adjacency" | "unit-complete" | "unit-forced" | "contradiction";

export interface Hint {
  kind: HintKind;
  scope: HintScope;
  text: string;
  cells: string[];
  decisiveCells: string[];
  method: HintMethod;
  difficulty: number;
  proofCost: number;
}

const key = (r: number, c: number) => `${r},${c}`;

function unitCells(puzzle: NormalizedPuzzle, scope: HintScope, unit: number): string[] {
  const cells: string[] = [];
  for (let r = 0; r < puzzle.size; r++) {
    for (let c = 0; c < puzzle.size; c++) {
      if ((scope === "row" && r === unit) || (scope === "column" && c === unit) ||
        (scope === "region" && puzzle.regions[r][c] === unit)) {
        cells.push(key(r, c));
      }
    }
  }
  return cells;
}

function hasCrownNear(puzzle: NormalizedPuzzle, r: number, c: number): boolean {
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < puzzle.size && nc >= 0 && nc < puzzle.size && puzzle.initial[nr][nc] === "C") {
        return true;
      }
    }
  }
  return false;
}

function candidatesForUnit(puzzle: NormalizedPuzzle, scope: HintScope, unit: number): string[] {
  const cells = unitCells(puzzle, scope, unit);
  return cells.filter((position) => {
    const [r, c] = position.split(",").map(Number);
    if (puzzle.initial[r][c] !== "?" || hasCrownNear(puzzle, r, c)) return false;
    return placedInUnit(puzzle, "row", r) < puzzle.crownsPerRow &&
      placedInUnit(puzzle, "column", c) < puzzle.crownsPerColumn &&
      placedInUnit(puzzle, "region", puzzle.regions[r][c]) < puzzle.crownsPerRegion;
  });
}

function placedInUnit(puzzle: NormalizedPuzzle, scope: HintScope, unit: number): number {
  return unitCells(puzzle, scope, unit).filter((position) => {
    const [r, c] = position.split(",").map(Number);
    return puzzle.initial[r][c] === "C";
  }).length;
}

function analysisContext(puzzle: NormalizedPuzzle, r: number, c: number): string[] {
  const cells = new Set<string>();
  for (const position of unitCells(puzzle, "row", r)) cells.add(position);
  for (const position of unitCells(puzzle, "column", c)) cells.add(position);
  for (const position of unitCells(puzzle, "region", puzzle.regions[r][c])) cells.add(position);
  return [...cells];
}

/** Return deductions that follow directly from the currently visible board. */
export function findHints(puzzle: NormalizedPuzzle): Hint[] {
  const hints: Hint[] = [];
  const seen = new Set<string>();
  const add = (hint: Hint) => {
    const id = `${hint.kind}:${hint.scope}:${hint.cells.join(";")}`;
    if (!seen.has(id)) {
      seen.add(id);
      hints.push(hint);
    }
  };

  for (const [scope, label] of [["row", "row"], ["column", "column"], ["region", "region"]] as const) {
    for (let unit = 0; unit < puzzle.size; unit++) {
      const candidates = candidatesForUnit(puzzle, scope, unit);
      const need = puzzle.crownsPerRow - placedInUnit(puzzle, scope, unit);
      if (need <= 0 && candidates.length > 0) {
        add({
          kind: "cross",
          scope,
          method: "unit-complete",
          difficulty: 1,
          proofCost: 0,
          text: `This ${label} already has all its queens, so the highlighted cells cannot contain one.`,
          cells: unitCells(puzzle, scope, unit).filter((position) => {
            const [r, c] = position.split(",").map(Number);
            return puzzle.initial[r][c] === "?";
          }),
          decisiveCells: candidates,
        });
      } else if (need > 0 && candidates.length === need) {
        add({
          kind: "queen",
          scope,
          method: "unit-forced",
          difficulty: 2,
          proofCost: 0,
          text: `This ${label} is missing ${need === 1 ? "one queen" : `${need} queens`}, and it can only be in the highlighted cells.`,
          cells: unitCells(puzzle, scope, unit),
          decisiveCells: candidates,
        });
      }
    }
  }

  for (let r = 0; r < puzzle.size; r++) {
    for (let c = 0; c < puzzle.size; c++) {
      if (puzzle.initial[r][c] !== "C") continue;
      const neighbors: string[] = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < puzzle.size && nc >= 0 && nc < puzzle.size && puzzle.initial[nr][nc] === "?") {
            neighbors.push(key(nr, nc));
          }
        }
      }
      if (neighbors.length > 0) {
        add({
          kind: "cross",
          scope: "neighbors",
          method: "adjacency",
          difficulty: 0,
          proofCost: 0,
          text: "Queens cannot touch, so the cells highlighted around this queen can be crossed out.",
          cells: [key(r, c), ...neighbors],
          decisiveCells: neighbors,
        });
      }
    }
  }

  // Direct rules are cheap, but many deductions only appear after combining
  // row, column, region, and adjacency constraints. Prove those by testing
  // both possible values and only report assumptions that are impossible.
  for (let r = 0; r < puzzle.size; r++) {
    for (let c = 0; c < puzzle.size; c++) {
      if (puzzle.initial[r][c] !== "?") continue;
        const position = key(r, c);
        const context = analysisContext(puzzle, r, c);
        const queen = testAssumptionDetailed(puzzle, r, c, "C");
        if (queen.status === "unsatisfiable") {
          add({
            kind: "cross",
            scope: "analysis",
            method: "contradiction",
            difficulty: 4,
            proofCost: queen.nodes,
            text: "A queen cannot go in this highlighted cell: placing one here makes the highlighted constraints impossible to complete.",
            cells: context,
            decisiveCells: [position],
          });
          continue;
        }
        if (queen.status === "unknown") continue;
        const empty = testAssumptionDetailed(puzzle, r, c, ".");
        if (empty.status === "unsatisfiable") {
          add({
            kind: "queen",
            scope: "analysis",
            method: "contradiction",
            difficulty: 4,
            proofCost: empty.nodes,
            text: "This highlighted cell must contain a queen: ruling it out makes the highlighted constraints impossible to complete.",
            cells: context,
            decisiveCells: [position],
          });
        }
    }
  }

  return hints
    .sort((a, b) => a.difficulty - b.difficulty || a.proofCost - b.proofCost ||
      a.decisiveCells.length - b.decisiveCells.length || a.cells.join(";").localeCompare(b.cells.join(";")));
}
