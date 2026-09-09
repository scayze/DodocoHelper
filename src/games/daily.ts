import { dayKeyUTC, type LeaderboardGameId } from "../leaderboard/types.js";
import { todayUTC } from "../leaderboard/api.js";

export type DailySeeds = Record<LeaderboardGameId, number>;

export interface DailySeedResponse {
  day: string;
  seeds: DailySeeds;
}

/** Deterministic PRNG (mulberry32); shared by all daily board generation. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of a string to a uint32 seed (offline fallback path). */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Offline fallback: deterministic seeds derived locally from the day key. */
export function localDailySeeds(day: string = todayUTC()): DailySeedResponse {
  const seeds = {} as DailySeeds;
  for (const game of ["crowns", "minesweeper", "seasons", "tents"] as const) {
    seeds[game] = hashSeed(`${day}:${game}`);
  }
  return { day, seeds };
}

function isDailySeedResponse(value: unknown): value is DailySeedResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["day"] !== "string") return false;
  const seeds = v["seeds"] as Record<string, unknown> | undefined;
  if (typeof seeds !== "object" || seeds === null) return false;
  return (["crowns", "minesweeper", "seasons", "tents"] as const).every(
    (g) => typeof seeds[g] === "number" && Number.isInteger(seeds[g] as number),
  );
}

/**
 * Daily seeds: server-provided, board generated client-side. Falls back to
 * locally derived seeds when the API is unreachable so the game still works
 * offline (leaderboard submit path is unaffected).
 */
export async function fetchDailySeeds(day: string = dayKeyUTC()): Promise<DailySeedResponse> {
  try {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 8000);
    let res: Response;
    try {
      res = await fetch(`/api/daily-seed?day=${encodeURIComponent(day)}`, {
        signal: ctrl.signal,
      });
    } finally {
      window.clearTimeout(timer);
    }
    if (!res.ok) return localDailySeeds(day);
    const body = (await res.json()) as unknown;
    if (!isDailySeedResponse(body)) return localDailySeeds(day);
    return body;
  } catch {
    return localDailySeeds(day);
  }
}
