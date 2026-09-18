/** Daily/endless mode state + persisted endless settings (one slot per game).
 *
 * The mode itself is session-only: every load boots into daily. Only the
 * endless *settings* persist (localStorage `dodoco:endless:<game>`).
 */

import { LEADERBOARD_GAMES } from "../leaderboard/types.js";
import { storageGet, storageSet, storageReadJson } from "../storage.js";
import type { GameId } from "./types.js";

export type PlayMode = "daily" | "endless";

export interface MinesEndlessSettings {
  size: number;
  mines: number;
}

export interface CrownsEndlessSettings {
  size: number;
}

export interface SeasonsEndlessSettings {
  size: number;
}

export interface TentsEndlessSettings {
  size: number;
  trees: number;
}

export interface SnapshotEndlessSettings {
  // Single round; no tunable settings yet. Kept as an object so the
  // shared endless-settings plumbing has a slot to persist.
}

export type EndlessSettings =
  | MinesEndlessSettings
  | CrownsEndlessSettings
  | SeasonsEndlessSettings
  | TentsEndlessSettings
  | SnapshotEndlessSettings;

const KEY_PREFIX = "dodoco:endless:";

export const MINES_DEFAULTS: MinesEndlessSettings = { size: 9, mines: 15 };
export const CROWNS_DEFAULTS: CrownsEndlessSettings = { size: 9 };
export const SEASONS_DEFAULTS: SeasonsEndlessSettings = { size: 10 };
export const TENTS_DEFAULTS: TentsEndlessSettings = { size: 8, trees: 13 };
export const SNAPSHOT_DEFAULTS: SnapshotEndlessSettings = {};

export const LIMITS = {
  mines: { size: [6, 12], mines: [1, 60] },
  // Crowns are always 2 per row/column/region: boards with other counts are
  // never fully deductible from an empty grid, so the no-prefill generator
  // cannot produce them.
  crowns: { size: [9, 10] },
  seasons: { size: [6, 12] },
  tents: { size: [5, 10], trees: [2, 23] },
} as const;

/** Clamp to int range; non-numbers fall back (then get clamped too). */
export function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Raw user input (e.g. input values are strings); numbers still accepted. */
export interface RawSettings {
  size?: unknown;
  mines?: unknown;
  trees?: unknown;
}

/** Kings-cap bound for a no-touch tent set: ceil(size/2)^2, minus slack. */
export function tentsMaxForSize(size: number): number {
  return Math.ceil(size / 2) ** 2 - 2;
}

/** Default tree count for a size (~1.6 per row, as the generator used). */
export function defaultTreesForSize(size: number): number {
  return Math.max(2, Math.min(Math.round(size * 1.6), tentsMaxForSize(size)));
}

export function clampMinesSettings(raw: RawSettings): MinesEndlessSettings {
  const size = clampInt(raw.size, LIMITS.mines.size[0], LIMITS.mines.size[1], MINES_DEFAULTS.size);
  // Always leave room to play: at most half the cells hold mines.
  const maxMines = Math.max(1, Math.floor((size * size) / 2));
  const mines = clampInt(raw.mines, LIMITS.mines.mines[0], Math.min(LIMITS.mines.mines[1], maxMines), MINES_DEFAULTS.mines);
  return { size, mines: Math.min(mines, maxMines) };
}

export function clampCrownsSettings(raw: RawSettings): CrownsEndlessSettings {
  return {
    size: clampInt(raw.size, LIMITS.crowns.size[0], LIMITS.crowns.size[1], CROWNS_DEFAULTS.size),
  };
}

export function clampSeasonsSettings(raw: RawSettings): SeasonsEndlessSettings {
  return {
    size: clampInt(raw.size, LIMITS.seasons.size[0], LIMITS.seasons.size[1], SEASONS_DEFAULTS.size),
  };
}

export function clampTentsSettings(raw: RawSettings): TentsEndlessSettings {
  const size = clampInt(raw.size, LIMITS.tents.size[0], LIMITS.tents.size[1], TENTS_DEFAULTS.size);
  // Missing/non-numeric trees falls back to the per-size default (legacy
  // saves only carry size); numeric input is clamped to the per-size max.
  const max = Math.max(2, tentsMaxForSize(size));
  const trees = raw.trees === undefined
    ? defaultTreesForSize(size)
    : clampInt(raw.trees, 2, max, defaultTreesForSize(size));
  return { size, trees };
}

export function clampSnapshotSettings(): SnapshotEndlessSettings {
  return {};
}

const CLAMPERS = {
  minesweeper: clampMinesSettings,
  crowns: clampCrownsSettings,
  seasons: clampSeasonsSettings,
  tents: clampTentsSettings,
  snapshot: clampSnapshotSettings,
} as const;

const DEFAULTS = {
  minesweeper: MINES_DEFAULTS,
  crowns: CROWNS_DEFAULTS,
  seasons: SEASONS_DEFAULTS,
  tents: TENTS_DEFAULTS,
  snapshot: SNAPSHOT_DEFAULTS,
} as const;

export function loadEndlessSettings<G extends GameId>(
  game: G,
): (typeof DEFAULTS)[G] {
  const defaults = DEFAULTS[game];
  const parsed = storageReadJson(`${KEY_PREFIX}${game}`) as Partial<(typeof DEFAULTS)[G]> | null;
  if (typeof parsed !== "object" || parsed === null) return { ...defaults };
  const clamper = CLAMPERS[game] as (p: object) => (typeof DEFAULTS)[G];
  return clamper({ ...defaults, ...parsed });
}

export function saveEndlessSettings(game: GameId, settings: EndlessSettings): void {
  storageSet(`${KEY_PREFIX}${game}`, JSON.stringify(settings));
}

/**
 * Per-game endless unlock: finishing today's daily (win or loss) reveals
 * the endless button for that game. Stored as the UTC day string per game,
 * so the unlock lasts the rest of the day and re-locks at midnight rollover.
 * Independent of leaderboard submits.
 */
const UNLOCK_KEY_PREFIX = "dodoco:endless-unlocked:";

/** Every endless-owned key (settings + per-day unlock) for storage resets. */
export function allEndlessKeys(): string[] {
  const keys: string[] = [];
  for (const game of LEADERBOARD_GAMES) {
    keys.push(`${KEY_PREFIX}${game}`);
    keys.push(`${UNLOCK_KEY_PREFIX}${game}`);
  }
  return keys;
}

export function isEndlessUnlocked(gameId: GameId, day: string): boolean {
  return storageGet(`${UNLOCK_KEY_PREFIX}${gameId}`) === day;
}

export function setEndlessUnlocked(gameId: GameId, day: string): void {
  storageSet(`${UNLOCK_KEY_PREFIX}${gameId}`, day);
}
