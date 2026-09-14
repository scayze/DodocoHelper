/** Stored-slice model for the minesweeper board: shape + validation for
 * persistence. Pure module (no DOM) so the test build covers the exact
 * validator the controller uses when restoring a saved board.
 *
 * The mine layout (`mines`) is the single source of truth: `adjacent` is
 * derived from it (0-8 counts, -1 on mines) and gets recomputed on restore,
 * so values there are only loosely checked (any integer grid of the right
 * dims; -1 is legitimate).
 */

import { isBoolGrid, isIntGrid, isStrGrid } from "../persist.js";
import { LIMITS } from "../mode.js";
import type { MineBoard } from "./logic.js";
import type { Opening } from "./solver.js";

export interface MineStored {
  board: MineBoard;
  opening: Opening | null;
  started: boolean;
  resultReported: boolean;
}

const MINE_STATES = new Set(["hidden", "revealed", "flagged"]);

/** Validate a stored minesweeper state slice; called by loadBoardState. */
export function isMineStored(value: unknown): value is MineStored {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  const b = s["board"] as Record<string, unknown> | null;
  if (typeof b !== "object" || b === null) return false;
  const size = b["size"];
  const mines = b["mines"];
  if (
    !Number.isInteger(size) ||
    (size as number) < LIMITS.mines.size[0] ||
    (size as number) > LIMITS.mines.size[1] ||
    !Number.isInteger(b["mineCount"]) ||
    (b["mineCount"] as number) < 1 ||
    !isBoolGrid(mines, size as number) ||
    // Adjacent holds -1 on mine cells; values are recomputed from `mines`
    // on restore anyway, so any int grid with the right dims passes here.
    !isIntGrid(b["adjacent"], size as number, -1_000_000) ||
    !isStrGrid(b["state"], size as number, MINE_STATES) ||
    typeof b["placed"] !== "boolean" ||
    typeof b["over"] !== "boolean" ||
    typeof b["won"] !== "boolean" ||
    !Number.isInteger(b["revealedCount"]) ||
    (b["revealedCount"] as number) < 0 ||
    typeof s["started"] !== "boolean" ||
    typeof s["resultReported"] !== "boolean"
  ) {
    return false;
  }
  // The stored mine count must match the stored layout exactly.
  const placed = (mines as boolean[][]).flat().filter(Boolean).length;
  if (placed !== (b["mineCount"] as number)) return false;
  const opening = s["opening"];
  if (opening !== null) {
    if (typeof opening !== "object") return false;
    const o = opening as Record<string, unknown>;
    if (!Number.isInteger(o["r"]) || !Number.isInteger(o["c"])) return false;
  }
  return true;
}