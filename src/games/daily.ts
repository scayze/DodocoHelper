import { LEADERBOARD_GAMES, dayKeyUTC, type LeaderboardGameId } from "../leaderboard/types.js";
import { apiUrl, todayUTC } from "../leaderboard/api.js";
import { fnv1a } from "./rng.js";

// Back-compat re-exports: board generators import the RNG from here. The
// single implementations live in rng.ts (server compiles that module too).
export { fnv1a as hashSeed, mulberry32 } from "./rng.js";

export type DailySeeds = Record<LeaderboardGameId, number>;

export interface DailySeedResponse {
  day: string;
  seeds: DailySeeds;
}

/** Offline fallback: deterministic seeds derived locally from the day key. */
export function localDailySeeds(day: string = todayUTC()): DailySeedResponse {
  const seeds = {} as DailySeeds;
  for (const game of LEADERBOARD_GAMES) {
    seeds[game] = fnv1a(`${day}:${game}`);
  }
  return { day, seeds };
}

function isDailySeedResponse(value: unknown): value is DailySeedResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["day"] !== "string") return false;
  const seeds = v["seeds"] as Record<string, unknown> | undefined;
  if (typeof seeds !== "object" || seeds === null) return false;
  return LEADERBOARD_GAMES.every(
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
      res = await fetch(apiUrl(`/daily-seed?day=${encodeURIComponent(day)}`), {
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
