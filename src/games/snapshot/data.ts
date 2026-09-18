import { SNAPSHOT_ITEMS } from "./items.js";
import { isSnapshotItem, type SnapshotItem } from "./types.js";

const ITEMS: SnapshotItem[] = SNAPSHOT_ITEMS.filter(isSnapshotItem);

export function snapshotItems(): SnapshotItem[] {
  return ITEMS;
}

/** Deterministic pick for daily (seeded), uniform random for endless. */
export function pickDailyIndex(seed: number): number {
  if (ITEMS.length === 0) return 0;
  return Math.abs(seed >>> 0) % ITEMS.length;
}

export function pickRandomIndex(rand: () => number = Math.random): number {
  if (ITEMS.length === 0) return 0;
  return Math.floor(rand() * ITEMS.length) % ITEMS.length;
}

/** Re-export scoring for the controller. */
export { haversineKm, locationScore, yearScore, totalScore, formatDistance } from "./logic.js";
