import { CROWN, EMPTY, UNKNOWN } from "./types.js";

/** Cycle an editable cell through unmarked, cross, queen, and back again. */
export function nextMark(mark: string): typeof UNKNOWN | typeof EMPTY | typeof CROWN {
  if (mark === UNKNOWN) return EMPTY;
  if (mark === EMPTY) return CROWN;
  return UNKNOWN;
}
