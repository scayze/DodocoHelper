/** Shared types for the crowns puzzle solver. */

export const CROWN = "C";
export const EMPTY = ".";
export const UNKNOWN = "?";

/** Raw (unvalidated) puzzle input, as parsed from JSON. */
export interface PuzzleInput {
  size?: number;
  crownsPerRow?: number;
  crownsPerColumn?: number;
  crownsPerRegion?: number;
  regions: number[][];
  /** "?" unknown, "C" pre-placed crown, "." / "X" forced empty. Defaults to all "?". */
  initial?: string[][];
  /** Optional per-region colors ("#RRGGBB") used only for rendering. */
  palette?: string[];
}

/** Validated + defaulted puzzle. */
export interface NormalizedPuzzle {
  size: number;
  crownsPerRow: number;
  crownsPerColumn: number;
  crownsPerRegion: number;
  regions: number[][];
  regionCount: number;
  /** Normalized to "?", "C", "." only. */
  initial: string[][];
  /** Normalized "#RRGGBB" per region id, or null when absent. */
  palette: string[] | null;
}

export interface CrownPos {
  r: number;
  c: number;
}

export type SolveStatus = "solved" | "unsolvable" | "invalid";

export interface SolveResult {
  status: SolveStatus;
  /** Explicit full grid of "C" / "." (null unless solved). */
  solution: string[][] | null;
  crowns: CrownPos[] | null;
  errors: string[];
}

export interface SolveOptions {
  /** Max number of solutions to collect (default 1). */
  limit?: number;
  /** Safety cap on search nodes (default 2_000_000). */
  budget?: number;
}
