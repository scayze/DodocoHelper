/** Stored-slice model for the shapes board: shape + validation for
 * persistence. Pure module (no DOM) so the test build covers the exact
 * validator the controller uses when restoring a saved board.
 */

import { CELL_COUNT, isCard, type ShapesBoard } from "./types.js";

export interface ShapesStored {
  board: ShapesBoard;
  moveCount: number;
  /** Selected cell (0..15) or null. */
  selected: number | null;
  winReported: boolean;
}

function isPos(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === CELL_COUNT &&
    value.every((v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < CELL_COUNT) &&
    new Set(value as number[]).size === CELL_COUNT
  );
}

/** Validate a stored shapes state slice; called by loadBoardState. */
export function isShapesStored(value: unknown): value is ShapesStored {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  const b = s["board"] as Record<string, unknown> | null;
  if (typeof b !== "object" || b === null) return false;
  if (
    !Array.isArray(b["cards"]) ||
    (b["cards"] as unknown[]).length !== CELL_COUNT ||
    !(b["cards"] as unknown[]).every(isCard) ||
    !isPos(b["pos"]) ||
    typeof b["over"] !== "boolean" ||
    typeof b["won"] !== "boolean" ||
    !Number.isInteger(s["moveCount"]) ||
    (s["moveCount"] as number) < 0 ||
    !(s["selected"] === null ||
      (Number.isInteger(s["selected"]) &&
        (s["selected"] as number) >= 0 &&
        (s["selected"] as number) < CELL_COUNT)) ||
    typeof s["winReported"] !== "boolean"
  ) {
    return false;
  }
  return true;
}
