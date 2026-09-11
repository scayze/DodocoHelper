import {
  CLIENT_ID_RE,
  MAX_DURATION_MS,
  MAX_NAME_LENGTH,
  MIN_NAME_LENGTH,
  isLeaderboardGame,
  type LeaderboardGameId,
  type ScoreSubmit,
} from "../src/leaderboard/types.js";

export interface ValidSubmit extends ScoreSubmit {
  game: LeaderboardGameId;
}

/** Trim + collapse whitespace; never throws. */
export function normalizeName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LENGTH + 10);
}

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

export function validateSubmit(body: unknown):
  | { ok: true; value: ValidSubmit }
  | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Body must be a JSON object." };
  }
  const b = body as Record<string, unknown>;

  if (!isLeaderboardGame(b["game"])) {
    return { ok: false, error: "Unknown game. Expected crowns, minesweeper, seasons or tents." };
  }
  const name = normalizeName(b["displayName"]);
  if (name.length < MIN_NAME_LENGTH) {
    return { ok: false, error: "displayName must be at least 2 characters." };
  }
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, error: "displayName must be at most 20 characters." };
  }
  // Reject angle brackets to keep the dumbest XSS path closed; the
  // frontend also renders with textContent.
  if (/[<>]/.test(name)) {
    return { ok: false, error: "displayName must not contain < or >." };
  }
  if (typeof b["clientId"] !== "string" || !CLIENT_ID_RE.test(b["clientId"])) {
    return { ok: false, error: "clientId must be a UUID." };
  }
  if (!isInt(b["durationMs"]) || b["durationMs"] < 1 || b["durationMs"] > MAX_DURATION_MS) {
    return { ok: false, error: "durationMs must be an integer between 1 and 86400000." };
  }
  const moves = b["moves"] === undefined ? 0 : b["moves"];
  const hintsUsed = b["hintsUsed"] === undefined ? 0 : b["hintsUsed"];
  if (!isInt(moves) || moves < 0 || moves > 100_000) {
    return { ok: false, error: "moves must be an integer between 0 and 100000." };
  }
  if (!isInt(hintsUsed) || hintsUsed < 0 || hintsUsed > 10_000) {
    return { ok: false, error: "hintsUsed must be an integer between 0 and 10000." };
  }
  const game: LeaderboardGameId = b["game"];
  // Primary metric (time is only the tiebreak for these games):
  // seasons = blocks left, minesweeper = percent cleared 0..100.
  // Crowns/tents are time-only boards: score must be absent or 0, won true.
  const scoreRaw = b["score"] === undefined ? 0 : b["score"];
  if (!isInt(scoreRaw) || scoreRaw < 0 || scoreRaw > 100) {
    return { ok: false, error: "score must be an integer between 0 and 100." };
  }
  const wonRaw = b["won"] === undefined ? true : b["won"];
  if (typeof wonRaw !== "boolean") {
    return { ok: false, error: "won must be a boolean." };
  }
  if (game === "seasons") {
    if (wonRaw !== (scoreRaw === 0)) {
      return { ok: false, error: "seasons: won must match score === 0." };
    }
  } else if (game === "minesweeper") {
    if (wonRaw !== (scoreRaw === 100)) {
      return { ok: false, error: "minesweeper: won must match score === 100." };
    }
  } else if (!wonRaw || scoreRaw !== 0) {
    return { ok: false, error: "crowns/tents boards are win-only: won must be true and score 0." };
  }
  return {
    ok: true,
    value: {
      game,
      displayName: name,
      clientId: (b["clientId"] as string).toLowerCase(),
      durationMs: b["durationMs"],
      moves,
      hintsUsed,
      score: scoreRaw,
      won: wonRaw,
    },
  };
}
