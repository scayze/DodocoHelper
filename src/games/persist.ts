/** Per-mode board-state persistence (daily + endless), surviving reloads.
 *
 * Daily entries are bound to their UTC day key: a new day deals a new seed,
 * so any payload whose day is not today is dropped (and cleared) on load.
 * Endless entries store `day: null` and always restore.
 *
 * The stored envelope is `{ v, day, elapsedMs, timerLive, state }`. `state`
 * is game-specific; each game validates and maps its slice via a callback,
 * so this module knows nothing about board shapes.
 *
 * Writes are best-effort (try/catch): in private mode or on quota errors
 * persistence simply doesn't stick and the session still works.
 */

import { isValidDay, LEADERBOARD_GAMES } from "../leaderboard/types.js";
import { storageGet, storageRemove, storageSet, storageReadJson } from "../storage.js";
import type { GameId } from "./types.js";
import type { PlayMode } from "./mode.js";

/** Bump when the envelope or any game state slice changes shape. */
export const BOARD_STATE_VERSION = 1;

/** Uniform n×n grid validators shared by the per-game stored-slice checks. */
export function isBoolGrid(v: unknown, n: number): boolean {
  if (!Array.isArray(v) || v.length !== n) return false;
  return v.every(
    (row) => Array.isArray(row) && row.length === n && row.every((c) => typeof c === "boolean"),
  );
}

export function isIntGrid(v: unknown, n: number, min = 0): boolean {
  if (!Array.isArray(v) || v.length !== n) return false;
  return v.every(
    (row) =>
      Array.isArray(row) && row.length === n && row.every((c) => Number.isInteger(c) && (c as number) >= min),
  );
}

export function isStrGrid(v: unknown, n: number, alpha: ReadonlySet<string>): boolean {
  if (!Array.isArray(v) || v.length !== n) return false;
  return v.every(
    (row) => Array.isArray(row) && row.length === n && row.every((c) => typeof c === "string" && alpha.has(c)),
  );
}

export interface StoredBoard<TSlot> {
  /** UTC day key (daily only; null for endless). */
  day: string | null;
  /** Banked run-timer time at save, so reloaded boards keep their clocks. */
  elapsedMs: number;
  /** Whether the board was ever played (false = parked, start fresh). */
  timerLive: boolean;
  /** Game-specific state slice. */
  state: TSlot;
}

const KEY_PREFIX = "dodoco:board:";

export function boardStateKey(game: GameId, mode: PlayMode): string {
  return `${KEY_PREFIX}${game}:${mode}`;
}

/** Every board-state key owned by the site (for storage resets). */
export function allBoardStateKeys(): string[] {
  const keys: string[] = [];
  for (const game of LEADERBOARD_GAMES) {
    keys.push(boardStateKey(game, "daily"));
    keys.push(boardStateKey(game, "endless"));
  }
  return keys;
}

function isEnvelope(value: unknown): value is StoredBoard<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    e["v"] === BOARD_STATE_VERSION &&
    (e["day"] === null || typeof e["day"] === "string") &&
    typeof e["elapsedMs"] === "number" &&
    Number.isInteger(e["elapsedMs"]) &&
    (e["elapsedMs"] as number) >= 0 &&
    typeof e["timerLive"] === "boolean" &&
    typeof e["state"] === "object" &&
    e["state"] !== null
  );
}

export interface RestoredBoard<TSlot> {
  state: TSlot;
  elapsedMs: number;
  timerLive: boolean;
}

/**
 * Load and validate a stored board, or null when absent/corrupt. Daily
 * payloads from any day other than `today` are removed and dropped: a new
 * day means a new seed, so the old board is worthless (never replayable).
 * Callers seed the day key into their own slot from `mode`/`today`.
 */
export function loadBoardState<TSlot>(
  game: GameId,
  mode: PlayMode,
  isState: (value: unknown) => value is TSlot,
  today: string,
): RestoredBoard<TSlot> | null {
  if (storageGet(boardStateKey(game, mode)) === null) return null;
  const parsed: unknown = storageReadJson(boardStateKey(game, mode));
  if (parsed === null) {
    clearBoardState(game, mode);
    return null;
  }
  if (!isEnvelope(parsed) || !isState(parsed.state)) {
    clearBoardState(game, mode);
    return null;
  }
  if (parsed.day !== null && (!isValidDay(parsed.day) || parsed.day !== today)) {
    clearBoardState(game, mode);
    return null;
  }
  return { state: parsed.state, elapsedMs: parsed.elapsedMs, timerLive: parsed.timerLive };
}

/** Persist the active board for a game/mode (envelope gets `v` stamped in). */
export function saveBoardState<TSlot>(
  game: GameId,
  mode: PlayMode,
  payload: StoredBoard<TSlot>,
): void {
  storageSet(boardStateKey(game, mode), JSON.stringify({ v: BOARD_STATE_VERSION, ...payload }));
}

/** Drop a stored board (corrupt payloads, midnight rollover cleanup). */
export function clearBoardState(game: GameId, mode: PlayMode): void {
  storageRemove(boardStateKey(game, mode));
}