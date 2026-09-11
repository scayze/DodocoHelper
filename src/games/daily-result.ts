/** First-result persistence for fail-capable dailies (seasons, minesweeper).
 *
 * The server enforces one-shot-per-day via UNIQUE(day, game, client_id), but
 * without local memory a reload would redeal a fresh board and let the
 * player replay a finished daily (the replay submit just bounces as a
 * duplicate). Storing the first finish locally lets the game lock the daily
 * with the original result until midnight rollover.
 */

import { isLeaderboardGame, isValidDay, type LeaderboardGameId } from "../leaderboard/types.js";

export interface DailyResult {
  /** UTC day key `YYYY-MM-DD` of the finished daily. */
  day: string;
  won: boolean;
  /** Primary metric: blocks left (seasons) or percent cleared (minesweeper). */
  score: number;
  durationMs: number;
  moves: number;
}

const KEY_PREFIX = "dodoco:daily-result:";

export function dailyResultKey(game: LeaderboardGameId): string {
  return `${KEY_PREFIX}${game}`;
}

/** Every daily-result key owned by the site (for storage resets). */
export function allDailyResultKeys(): string[] {
  return (["crowns", "minesweeper", "seasons", "tents"] as const).map(dailyResultKey);
}

function isDailyResult(value: unknown): value is DailyResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["day"] === "string" &&
    isValidDay(v["day"]) &&
    typeof v["won"] === "boolean" &&
    typeof v["score"] === "number" &&
    Number.isInteger(v["score"]) &&
    (v["score"] as number) >= 0 &&
    (v["score"] as number) <= 100 &&
    typeof v["durationMs"] === "number" &&
    Number.isInteger(v["durationMs"]) &&
    (v["durationMs"] as number) > 0 &&
    typeof v["moves"] === "number" &&
    Number.isInteger(v["moves"]) &&
    (v["moves"] as number) >= 0
  );
}

export function loadDailyResult(game: LeaderboardGameId): DailyResult | null {
  try {
    const raw = localStorage.getItem(dailyResultKey(game));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isDailyResult(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Record the first finish of a daily; later finishes must not overwrite it. */
export function saveDailyResult(
  game: LeaderboardGameId,
  result: Omit<DailyResult, "day"> & { day?: string },
  today: string = new Date().toISOString().slice(0, 10),
): DailyResult {
  const stored: DailyResult = {
    day: result.day ?? today,
    won: result.won,
    score: Math.max(0, Math.min(100, Math.round(result.score))),
    durationMs: Math.max(1, Math.round(result.durationMs)),
    moves: Math.max(0, Math.round(result.moves)),
  };
  try {
    localStorage.setItem(dailyResultKey(game), JSON.stringify(stored));
  } catch {
    // Private mode etc: the server one-shot rule still guards resubmits.
  }
  return stored;
}

/** True when `game` already has a recorded finish for `day`. */
export function isDailyComplete(game: LeaderboardGameId, day: string): boolean {
  if (!isLeaderboardGame(game) || !isValidDay(day)) return false;
  return loadDailyResult(game)?.day === day;
}
