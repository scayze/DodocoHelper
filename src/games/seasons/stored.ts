/** Stored-slice model for the seasons board: shape + validation for
 * persistence. Pure module (no DOM) so the test build covers the exact
 * validator the controller uses when restoring a saved board.
 */

import { LIMITS } from "../mode.js";
import { SEASON_TYPES, type SeasonsBoard, type SeasonType } from "./logic.js";

export interface SeasonsStored {
  board: SeasonsBoard;
  moveCount: number;
  resultReported: boolean;
}

/** Validate a stored seasons state slice; called by loadBoardState. */
export function isSeasonsStored(value: unknown): value is SeasonsStored {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  const b = s["board"] as Record<string, unknown> | null;
  if (typeof b !== "object" || b === null) return false;
  const size = b["size"];
  const cells = b["cells"];
  if (
    !Number.isInteger(size) ||
    (size as number) < LIMITS.seasons.size[0] ||
    (size as number) > LIMITS.seasons.size[1] ||
    !Array.isArray(cells) ||
    cells.length !== size ||
    !cells.every((row) => {
      if (!Array.isArray(row) || row.length !== size) return false;
      return row.every((t) => {
        if (t === null) return true;
        if (typeof t !== "object") return false;
        const tm = t as Record<string, unknown>;
        return (
          typeof tm["t"] === "string" &&
          SEASON_TYPES.includes(tm["t"] as SeasonType) &&
          Number.isInteger(tm["id"])
        );
      });
    }) ||
    typeof b["over"] !== "boolean" ||
    typeof b["won"] !== "boolean" ||
    !Number.isInteger(s["moveCount"]) ||
    (s["moveCount"] as number) < 0 ||
    typeof s["resultReported"] !== "boolean"
  ) {
    return false;
  }
  return true;
}