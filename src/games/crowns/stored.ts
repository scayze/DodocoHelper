/** Stored-slice model for the crowns board: shape + validation for persistence.
 * Pure module (no DOM) so the test build can cover the exact validator the
 * controller uses when restoring a saved board.
 */

import { isIntGrid, isStrGrid } from "../persist.js";
import { LIMITS } from "../mode.js";
import type { NormalizedPuzzle } from "./types.js";

/** JSON-safe slice of a crowns slot (Set/function-free) for storage.
 * Hints and the shown-hints history are runtime-only and are not persisted:
 * after a reload the first Hint click recomputes them. */
export interface CrownsStored {
  puzzle: NormalizedPuzzle;
  solution: string[][];
  undo: Array<{ r: number; c: number; prev: string }>;
  solved: boolean;
}

const CROPTS = new Set(["C", ".", "?"]);

/** Validate a stored crowns state slice; called by loadBoardState. */
export function isCrownsStored(value: unknown): value is CrownsStored {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  const p = s["puzzle"] as Record<string, unknown> | null;
  if (typeof p !== "object" || p === null) return false;
  const size = p["size"];
  const palette = p["palette"];
  const undo = s["undo"];
  if (
    !Number.isInteger(size) ||
    (size as number) < LIMITS.crowns.size[0] ||
    (size as number) > LIMITS.crowns.size[1] ||
    !Number.isInteger(p["crownsPerRow"]) ||
    !Number.isInteger(p["crownsPerColumn"]) ||
    !Number.isInteger(p["crownsPerRegion"]) ||
    !Number.isInteger(p["regionCount"]) ||
    !isIntGrid(p["regions"], size as number) ||
    !isStrGrid(p["initial"], size as number, CROPTS) ||
    !isStrGrid(s["solution"], size as number, new Set(["C", "."])) ||
    typeof s["solved"] !== "boolean" ||
    !Array.isArray(undo) ||
    !undo.every((e) => {
      if (typeof e !== "object" || e === null) return false;
      const em = e as Record<string, unknown>;
      return (
        Number.isInteger(em["r"]) &&
        Number.isInteger(em["c"]) &&
        typeof em["prev"] === "string" &&
        CROPTS.has(em["prev"])
      );
    }) ||
    (palette !== null && (!Array.isArray(palette) || !palette.every((v) => typeof v === "string")))
  ) {
    return false;
  }
  return true;
}