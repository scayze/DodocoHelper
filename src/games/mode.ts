/** Daily/endless mode state + persisted endless settings (one slot per game).
 *
 * The mode itself is session-only: every load boots into daily. Only the
 * endless *settings* persist (localStorage `dodoco:endless:<game>`).
 */

import type { GameId } from "./types.js";

export type PlayMode = "daily" | "endless";

export interface MinesEndlessSettings {
  size: number;
  mines: number;
}

export interface CrownsEndlessSettings {
  size: number;
  crowns: number;
}

export interface SeasonsEndlessSettings {
  size: number;
}

export interface TentsEndlessSettings {
  size: number;
}

export type EndlessSettings =
  | MinesEndlessSettings
  | CrownsEndlessSettings
  | SeasonsEndlessSettings
  | TentsEndlessSettings;

const KEY_PREFIX = "dodoco:endless:";

export const MINES_DEFAULTS: MinesEndlessSettings = { size: 9, mines: 15 };
export const CROWNS_DEFAULTS: CrownsEndlessSettings = { size: 9, crowns: 2 };
export const SEASONS_DEFAULTS: SeasonsEndlessSettings = { size: 10 };
export const TENTS_DEFAULTS: TentsEndlessSettings = { size: 8 };

export const LIMITS = {
  mines: { size: [6, 12], mines: [1, 60] },
  crowns: { size: [6, 10], crowns: [1, 2] },
  seasons: { size: [6, 12] },
  tents: { size: [5, 10] },
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
  crowns?: unknown;
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
    crowns: clampInt(raw.crowns, LIMITS.crowns.crowns[0], LIMITS.crowns.crowns[1], CROWNS_DEFAULTS.crowns),
  };
}

export function clampSeasonsSettings(raw: RawSettings): SeasonsEndlessSettings {
  return {
    size: clampInt(raw.size, LIMITS.seasons.size[0], LIMITS.seasons.size[1], SEASONS_DEFAULTS.size),
  };
}

export function clampTentsSettings(raw: RawSettings): TentsEndlessSettings {
  return {
    size: clampInt(raw.size, LIMITS.tents.size[0], LIMITS.tents.size[1], TENTS_DEFAULTS.size),
  };
}

const CLAMPERS = {
  minesweeper: clampMinesSettings,
  crowns: clampCrownsSettings,
  seasons: clampSeasonsSettings,
  tents: clampTentsSettings,
} as const;

const DEFAULTS = {
  minesweeper: MINES_DEFAULTS,
  crowns: CROWNS_DEFAULTS,
  seasons: SEASONS_DEFAULTS,
  tents: TENTS_DEFAULTS,
} as const;

export function loadEndlessSettings<G extends GameId>(
  game: G,
): (typeof DEFAULTS)[G] {
  const defaults = DEFAULTS[game];
  try {
    const raw = localStorage.getItem(`${KEY_PREFIX}${game}`);
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw) as Partial<(typeof DEFAULTS)[G]>;
    if (typeof parsed !== "object" || parsed === null) return { ...defaults };
    const clamper = CLAMPERS[game] as (p: object) => (typeof DEFAULTS)[G];
    return clamper({ ...defaults, ...parsed });
  } catch {
    return { ...defaults };
  }
}

export function saveEndlessSettings(game: GameId, settings: EndlessSettings): void {
  try {
    localStorage.setItem(`${KEY_PREFIX}${game}`, JSON.stringify(settings));
  } catch {
    // Private mode etc: settings simply don't persist.
  }
}

/**
 * Endless unlock: solving today's daily reveals the endless button. Stored
 * as the UTC day string, so the unlock lasts the rest of the day and
 * re-locks at midnight rollover. Independent of leaderboard submits.
 */
const UNLOCK_KEY = "dodoco:endless-unlocked";

export function isEndlessUnlocked(day: string): boolean {
  try {
    return localStorage.getItem(UNLOCK_KEY) === day;
  } catch {
    return false;
  }
}

export function setEndlessUnlocked(day: string): void {
  try {
    localStorage.setItem(UNLOCK_KEY, day);
  } catch {
    // Private mode etc: unlock simply lasts the session.
  }
}
