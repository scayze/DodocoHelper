import { apiUrl } from "../../leaderboard/api.js";
import { isSnapshotItem, type SnapshotItem } from "./types.js";

/** Snapshot dataset = accepted Tinder rows (same schema, separate table).
 *  Loaded once per session from `/api/tinder/export`, validated item by
 *  item, stable id-sorted. Appends never reorder existing entries.
 *
 *  Note: the daily pick is `seed % len`, so accepting new photos mid-day
 *  can shift that day's puzzle for players who load later. Within one
 *  load the dataset is frozen, and every player loads the same export.
 */
let cache: SnapshotItem[] | null = null;
let inflight: Promise<SnapshotItem[]> | null = null;

export function snapshotItems(): SnapshotItem[] {
  return cache ?? [];
}

export function snapshotLoaded(): boolean {
  return cache !== null;
}

/** Single-flight fetch of the curated dataset. Never rejects ( [] ). */
export function loadSnapshotItems(): Promise<SnapshotItem[]> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = (async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        try {
          const res = await fetch(apiUrl("/tinder/export?decision=accepted"), {
            signal: ctrl.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = (await res.json()) as { items?: unknown };
          const items = Array.isArray(body.items)
            ? body.items.filter(isSnapshotItem)
            : [];
          items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          cache = items;
        } finally {
          clearTimeout(timer);
        }
      } catch {
        cache = [];
      }
      return cache;
    })();
  }
  return inflight;
}

/** Deterministic pick for daily (seeded), uniform random for endless. */
export function pickDailyIndex(seed: number): number {
  const len = (cache ?? []).length;
  if (len === 0) return 0;
  return Math.abs(seed >>> 0) % len;
}

export function pickRandomIndex(rand: () => number = Math.random): number {
  const len = (cache ?? []).length;
  if (len === 0) return 0;
  return Math.floor(rand() * len) % len;
}

/** Re-export scoring for the controller. */
export { haversineKm, locationScore, yearScore, totalScore, formatDistance } from "./logic.js";
