import { apiUrl } from "../../leaderboard/api.js";
import { isSnapshotItem, type SnapshotItem } from "./types.js";

/** Snapshot dataset = accepted Tinder rows (same schema, separate table).
 *  Loaded once per session from `/api/tinder/export`, validated item by
 *  item, stable id-sorted. Appends never reorder existing entries.
 *
 *  Daily freeze: each item carries `addedDay` (UTC acceptance day from
 *  tinder `decided_at`). The daily for day D picks from entries with
 *  `addedDay < D` only, so accepts today never shift today's puzzle.
 *  Within one load the dataset is frozen, and every player loading the
 *  same day sees the same eligible set.
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

/** Eligible entries for a daily day: accepted before that UTC day.
 *  Items without `addedDay` (legacy exports) count as eligible. */
export function eligibleSnapshotItems(day: string): SnapshotItem[] {
  const list = cache ?? [];
  const eligible = list.filter((it) => !it.addedDay || it.addedDay < day);
  // Brand-new DB where everything was accepted today: fall back to the
  // full list so the daily still resolves instead of going empty.
  return eligible.length > 0 ? eligible : list;
}

/** Deterministic pick for daily (seeded), uniform random for endless.
 *  The daily index is into the full id-sorted cache (so persisted
 *  `itemIndex` values resolve via the normal id-checked path), but the
 *  choice is `seed % eligible.length` over the pre-day entries only. */
export function pickDailyIndex(seed: number, day?: string): number {
  const list = cache ?? [];
  if (list.length === 0) return 0;
  if (day === undefined) return Math.abs(seed >>> 0) % list.length;
  const eligible = eligibleSnapshotItems(day);
  if (eligible.length === 0) return 0;
  const pick = eligible[Math.abs(seed >>> 0) % eligible.length]!;
  const full = list.indexOf(pick);
  return full >= 0 ? full : 0;
}

export function pickRandomIndex(rand: () => number = Math.random): number {
  const len = (cache ?? []).length;
  if (len === 0) return 0;
  return Math.floor(rand() * len) % len;
}

/** Re-export scoring for the controller. */
export { haversineKm, locationScore, yearScore, totalScore, formatDistance } from "./logic.js";
