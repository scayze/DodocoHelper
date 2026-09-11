/** Shared leaderboard contract: daily best-time boards, one per game. */

export const LEADERBOARD_GAMES = [
  "crowns",
  "minesweeper",
  "seasons",
  "tents",
] as const;

export type LeaderboardGameId = (typeof LEADERBOARD_GAMES)[number];

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const CLIENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_NAME_LENGTH = 20;
export const MIN_NAME_LENGTH = 2;
export const MAX_DURATION_MS = 86_400_000;
export const MAX_LIMIT = 100;

export interface ScoreSubmit {
  game: LeaderboardGameId;
  displayName: string;
  clientId: string;
  durationMs: number;
  moves: number;
  hintsUsed: number;
  /**
   * Primary ranking metric (time is only the tiebreak for these games):
   * - seasons: blocks left at game over (`remainingCount`, 0 = solved).
   * - minesweeper: percent of safe cells cleared `0..100` (100 = solved).
   * - crowns/tents: always 0 (unranked, time-only boards).
   */
  score: number;
  /** False when the daily was finished without solving it. */
  won: boolean;
}

/** Win-equivalent score per game (used to backfill pre-score rows). */
export function winScoreFor(game: LeaderboardGameId): number {
  return game === "minesweeper" ? 100 : 0;
}

export function formatScore(game: LeaderboardGameId, score: number): string {
  if (game === "minesweeper") return `${score}%`;
  if (game === "seasons") return score === 1 ? "1 block" : `${score} blocks`;
  return "";
}

export interface LeaderboardEntry extends ScoreSubmit {
  id: number;
  /** UTC day `YYYY-MM-DD` assigned server-side at submit time. */
  day: string;
  createdAt: string;
  updatedAt: string;
}

export interface LeaderboardResponse {
  game: LeaderboardGameId;
  day: string;
  entries: LeaderboardEntry[];
}

export function isLeaderboardGame(value: unknown): value is LeaderboardGameId {
  return (
    typeof value === "string" &&
    (LEADERBOARD_GAMES as readonly string[]).includes(value)
  );
}

/** UTC day key `YYYY-MM-DD` for a given instant (defaults to now). */
export function dayKeyUTC(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** Shift a `YYYY-MM-DD` day key by whole UTC days (month/year safe). */
export function shiftDayKey(day: string, deltaDays: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

export function isValidDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}
