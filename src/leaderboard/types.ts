/** Shared leaderboard contract: daily best-time boards, one per game. */

export const LEADERBOARD_GAMES = [
  "crowns",
  "minesweeper",
  "seasons",
  "tents",
  "snapshot",
] as const;

export type LeaderboardGameId = (typeof LEADERBOARD_GAMES)[number];

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const CLIENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_NAME_LENGTH = 14;
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

/** How each game's `score` participates in validation and ranking. */
export interface GameRules {
  /** Ranking significance of `score`: absent (time-only), or lower/higher is better. */
  metric: "time" | "lowerScore" | "higherScore";
  /** False when a run can only finish by winning (crowns/tents). */
  canLose: boolean;
}

/**
 * Single source for per-game win/score semantics, shared by server
 * validation (validate.ts), ranking (db.ts), and win-score defaults.
 */
export const GAME_RULES: Record<LeaderboardGameId, GameRules> = {
  // Time-only (win-only) boards: score is fixed at 0, ranking by duration.
  crowns: { metric: "time", canLose: false },
  tents: { metric: "time", canLose: false },
  // seasons: blocks left at the finish; 0 = solved. Losses still post.
  seasons: { metric: "lowerScore", canLose: true },
  // minesweeper: percent of safe cells cleared; 100 = solved. Losses post.
  minesweeper: { metric: "higherScore", canLose: true },
  // snapshot: 0..100 points (50 location + 50 year); every guess finishes.
  snapshot: { metric: "higherScore", canLose: false },
};

/** The exact score that counts as a win (0 unless a percent-based board). */
export function winScoreFor(game: LeaderboardGameId): number {
  return GAME_RULES[game].metric === "higherScore" ? 100 : 0;
}

export function formatScore(game: LeaderboardGameId, score: number): string {
  if (game === "minesweeper") return `${score}%`;
  if (game === "seasons") return score === 1 ? "1 block" : `${score} blocks`;
  if (game === "snapshot") return `${score} pts`;
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

/** Trim + collapse whitespace; shared by client gate and server validation. */
export function normalizeDisplayName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\s+/g, " ");
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
