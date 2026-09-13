import { LEADERBOARD_GAMES, type LeaderboardGameId } from "../src/leaderboard/types.js";
import { fnv1a } from "../src/games/rng.js";

export type DailySeeds = Record<LeaderboardGameId, number>;

export interface DailySeedResponse {
  day: string;
  seeds: DailySeeds;
}

/**
 * Deploy salt for daily seeds. Bump (e.g. `-v2`) to rotate every board at
 * once; clients generate boards from these seeds, so rotation invalidates
 * any in-progress day.
 */
export const SEED_SALT = "dodoco-daily-v1";

/**
 * Deterministic daily seeds: same day + same deploy => same seeds for every
 * player. No storage needed (pure function of the day key); boards are
 * generated client-side from these seeds.
 */
export function dailySeedsFor(day: string): DailySeedResponse {
  const seeds = {} as DailySeeds;
  for (const game of LEADERBOARD_GAMES) {
    seeds[game] = fnv1a(`${SEED_SALT}:${day}:${game}`);
  }
  return { day, seeds };
}
