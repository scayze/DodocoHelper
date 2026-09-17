/** Stored-slice model for the tents board: shape + validation for
 * persistence. Pure module (no DOM) so the test build covers the exact
 * validator the controller uses when restoring a saved board.
 */

import { isBoolGrid, isStrGrid } from "../persist.js";
import { LIMITS } from "../mode.js";
import type { CellMark, TentsBoard } from "./logic.js";

/** One undo step: either a single tap or a whole drag-paint stroke (atomic). */
export type TentsUndoEntry =
  | { r: number; c: number; prev: CellMark }
  | { stroke: Array<{ r: number; c: number; prev: CellMark }> };

export interface TentsStored {
  board: TentsBoard;
  moveCount: number;
  undoStack: TentsUndoEntry[];
  winReported: boolean;
}

function isUndoCell(e: unknown): e is { r: number; c: number; prev: CellMark } {
  if (typeof e !== "object" || e === null) return false;
  const em = e as Record<string, unknown>;
  return (
    Number.isInteger(em["r"]) &&
    Number.isInteger(em["c"]) &&
    typeof em["prev"] === "string" &&
    TENT_MARKS.has(em["prev"])
  );
}

const TENT_MARKS = new Set(["unknown", "tent", "grass"]);

/** Validate a stored tents state slice; called by loadBoardState. */
export function isTentsStored(value: unknown): value is TentsStored {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  const b = s["board"] as Record<string, unknown> | null;
  if (typeof b !== "object" || b === null) return false;
  const size = b["size"];
  const rowCounts = b["rowCounts"];
  const colCounts = b["colCounts"];
  const undo = s["undoStack"];
  if (
    !Number.isInteger(size) ||
    (size as number) < LIMITS.tents.size[0] ||
    (size as number) > LIMITS.tents.size[1] ||
    !isBoolGrid(b["trees"], size as number) ||
    !Array.isArray(rowCounts) ||
    rowCounts.length !== size ||
    !rowCounts.every((v) => Number.isInteger(v)) ||
    !Array.isArray(colCounts) ||
    colCounts.length !== size ||
    !colCounts.every((v) => Number.isInteger(v)) ||
    !isStrGrid(b["marks"], size as number, TENT_MARKS) ||
    typeof b["over"] !== "boolean" ||
    typeof b["won"] !== "boolean" ||
    !Number.isInteger(s["moveCount"]) ||
    (s["moveCount"] as number) < 0 ||
    typeof s["winReported"] !== "boolean" ||
    !Array.isArray(undo) ||
    !undo.every((e) => {
      if (isUndoCell(e)) return true;
      // Grouped drag-paint stroke: non-empty list of single-cell entries.
      if (typeof e !== "object" || e === null) return false;
      const g = (e as Record<string, unknown>)["stroke"];
      return Array.isArray(g) && g.length > 0 && g.every(isUndoCell);
    })
  ) {
    return false;
  }
  return true;
}