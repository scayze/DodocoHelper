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
