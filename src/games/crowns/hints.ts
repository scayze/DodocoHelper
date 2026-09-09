import type { NormalizedPuzzle } from "./types.js";
import { testAssumptionDetailed } from "./solver.js";
import type { ContradictionWitness } from "./solver.js";

export type HintKind = "queen" | "cross";
export type HintScope = "row" | "column" | "region" | "neighbors" | "analysis";
export type HintMethod = "adjacency" | "unit-complete" | "unit-forced" | "contradiction";
export type HintDifficulty = "Easy" | "Intermediate" | "Advanced";

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

function cellNames(positions: string[]): string {
  return positions.map(cellName).join(", ");
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

function witnessText(position: string, witness: ContradictionWitness | null): string {
  if (!witness) return "leave no valid option to finish the puzzle";
  if (witness.kind === "adjacency") {
    const other = witness.cells.find((cell) => cell !== position);
    return `touch the queen at ${other ? cellName(other) : "a neighboring cell"}`;
  }
  const unit = witness.scope === "search" ? "the puzzle" : `the marked ${witness.scope}`;
  return `leave no valid option to fill ${unit}`;
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

  for (const scope of ["row", "column", "region"] as const) {
    for (let unit = 0; unit < puzzle.size; unit++) {
      const candidates = candidatesForUnit(puzzle, scope, unit);
      const quota = unitQuota(puzzle, scope);
      const need = quota - placedInUnit(puzzle, scope, unit);
      if (need <= 0 && candidates.length > 0) {
        add({
          kind: "cross",
          scope,
          method: "unit-complete",
          difficulty: 1,
          proofCost: 0,
          difficultyLabel: "Easy",
          text: `${unitName(scope, unit)} already has its ${quota} queens. Cross out the highlighted unresolved cells.`,
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
          difficultyLabel: "Easy",
          text: `${unitName(scope, unit)} needs ${need} more ${need === 1 ? "queen" : "queens"}. Its only candidates are ${cellNames(candidates)}, so those highlighted cells must be queens.`,
          cells: [...new Set([...candidates, ...unitCells(puzzle, scope, unit)])],
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
          difficultyLabel: "Easy",
          text: `The queen at ${cellName(key(r, c))} touches the highlighted cells. Queens cannot touch, even diagonally, so cross them out.`,
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
        const queen = testAssumptionDetailed(puzzle, r, c, "C");
        if (queen.status === "unsatisfiable") {
          const evidence = queen.witness?.cells ?? analysisContext(puzzle, r, c);
          add({
            kind: "cross",
            scope: "analysis",
            method: "contradiction",
            difficulty: 4,
            proofCost: queen.nodes,
            difficultyLabel: "Advanced",
            text: `Placing a queen here would ${witnessText(position, queen.witness)}.`,
            cells: [...new Set([position, ...evidence])],
            decisiveCells: [position],
          });
          continue;
        }
        if (queen.status === "unknown") continue;
        const empty = testAssumptionDetailed(puzzle, r, c, ".");
        if (empty.status === "unsatisfiable") {
          const evidence = empty.witness?.cells ?? analysisContext(puzzle, r, c);
          add({
            kind: "queen",
            scope: "analysis",
            method: "contradiction",
            difficulty: 4,
            proofCost: empty.nodes,
            difficultyLabel: "Advanced",
            text: `Leaving this cell empty would ${empty.witness ? witnessText(position, empty.witness) : "leave no valid option to finish the puzzle"}, so it must contain a queen.`,
            cells: [...new Set([position, ...evidence])],
            decisiveCells: [position],
          });
        }
    }
  }

  return hints
    .sort((a, b) => a.difficulty - b.difficulty || a.proofCost - b.proofCost ||
      a.decisiveCells.length - b.decisiveCells.length || a.cells.join(";").localeCompare(b.cells.join(";")));
}
