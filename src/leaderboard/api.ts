import {
  MAX_NAME_LENGTH,
  MIN_NAME_LENGTH,
  dayKeyUTC,
  isLeaderboardGame,
  type LeaderboardGameId,
  type LeaderboardResponse,
  type ScoreSubmit,
} from "./types.js";

const CLIENT_KEY = "dodoco:clientId";
const NAME_KEY = "dodoco:displayName";
/** Dispatched on window whenever the saved display name changes. */
export const NAME_EVENT = "dodoco:name";
const QUEUE_KEY = "dodoco:pendingWins";
/** Pre-queue single-slot key; folded into the queue on first read. */
const LEGACY_KEY = "dodoco:pendingWin";
const QUEUE_VERSION = 1;

export interface QueuedWin {
  game: LeaderboardGameId;
  durationMs: number;
  moves: number;
  hintsUsed: number;
  /** Epoch ms when the win happened. */
  at: number;
  /** UTC day when queued; entries from a previous day are never submitted. */
  day: string;
}

export function getClientId(): string {
  let id = "";
  try {
    id = localStorage.getItem(CLIENT_KEY) ?? "";
  } catch {
    id = "";
  }
  if (/^[0-9a-f-]{36}$/i.test(id)) return id.toLowerCase();
  const fresh =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, "0").slice(-12)}`;
  try {
    localStorage.setItem(CLIENT_KEY, fresh);
  } catch {
    // Private mode: still return a stable id for this session.
  }
  return fresh;
}

/** Collapse whitespace like the server validator does. */
export function normalizeDisplayName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

export function isValidDisplayName(raw: string): boolean {
  const name = normalizeDisplayName(raw);
  return (
    name.length >= MIN_NAME_LENGTH &&
    name.length <= MAX_NAME_LENGTH &&
    !/[<>]/.test(name)
  );
}

/** Saved name, or "" when absent, invalid, or unreadable (counts as nameless). */
export function getDisplayName(): string {
  let raw = "";
  try {
    raw = localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
  const name = normalizeDisplayName(raw);
  return isValidDisplayName(name) ? name : "";
}

export function hasValidName(): boolean {
  return getDisplayName() !== "";
}

export function setDisplayName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, normalizeDisplayName(name));
  } catch {
    // Ignore storage failures; the name still applies to this session's submits.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(NAME_EVENT));
  }
}

function isQueuedWin(value: unknown): value is QueuedWin {
  if (typeof value !== "object" || value === null) return false;
  const w = value as Record<string, unknown>;
  return (
    isLeaderboardGame(w["game"]) &&
    typeof w["durationMs"] === "number" &&
    Number.isInteger(w["durationMs"]) &&
    (w["durationMs"] as number) > 0 &&
    typeof w["at"] === "number" &&
    typeof w["day"] === "string"
  );
}

function readQueue(): QueuedWin[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as {
      version?: number;
      wins?: unknown;
    };
    if (parsed.version !== QUEUE_VERSION || !Array.isArray(parsed.wins)) return [];
    return parsed.wins.filter(isQueuedWin);
  } catch {
    return [];
  }
}

function writeQueue(wins: QueuedWin[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify({ version: QUEUE_VERSION, wins }));
  } catch {
    // Ignore; the win still counts for this session's flush attempt.
  }
}

/** Fold a legacy single pending win into the queue (once), then drop the key. */
function migrateLegacy(): QueuedWin[] {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as {
      game?: unknown;
      durationMs?: unknown;
      moves?: unknown;
      hintsUsed?: unknown;
      at?: unknown;
    };
    if (!isLeaderboardGame(parsed.game) || typeof parsed.durationMs !== "number") return [];
    const at = typeof parsed.at === "number" ? parsed.at : Date.now();
    return [
      {
        game: parsed.game,
        durationMs: Math.max(1, Math.round(parsed.durationMs)),
        moves: Math.max(0, Math.round(Number(parsed.moves) || 0)),
        hintsUsed: Math.max(0, Math.round(Number(parsed.hintsUsed) || 0)),
        at,
        day: dayKeyUTC(new Date(at)),
      },
    ];
  } catch {
    return [];
  } finally {
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      // Ignore.
    }
  }
}

/**
 * Queue a win. One slot per game, earliest kept: the first attempt is the
 * would-be daily attempt, replays while nameless don't overwrite it.
 * Returns the queued entry.
 */
export function queueWin(win: {
  game: LeaderboardGameId;
  durationMs: number;
  moves?: number;
  hintsUsed?: number;
}): QueuedWin {
  const entry: QueuedWin = {
    game: win.game,
    durationMs: Math.max(1, Math.round(win.durationMs)),
    moves: Math.max(0, Math.round(win.moves ?? 0)),
    hintsUsed: Math.max(0, Math.round(win.hintsUsed ?? 0)),
    at: Date.now(),
    day: dayKeyUTC(),
  };
  const wins = [...migrateLegacy(), ...readQueue()];
  if (!wins.some((w) => w.game === entry.game)) wins.push(entry);
  writeQueue(wins);
  return entry;
}

/** Queued wins, oldest first. Migrates legacy entries and drops stale days. */
export function loadQueuedWins(): QueuedWin[] {
  const migrated = migrateLegacy();
  const wins = readQueue();
  const merged = [...wins];
  for (const m of migrated) {
    if (!merged.some((w) => w.game === m.game)) merged.push(m);
  }
  // Stale entries (queued on a previous UTC day) must never reach today's
  // board, so prune them here rather than trusting every caller to filter.
  const today = dayKeyUTC();
  const fresh = merged.filter((w) => w.day === today);
  if (migrated.length > 0 || fresh.length !== merged.length) writeQueue(fresh);
  return fresh.sort((a, b) => a.at - b.at);
}

export function dropQueuedWin(game: LeaderboardGameId): void {
  writeQueue(readQueue().filter((w) => w.game !== game));
}

export function clearQueuedWins(): void {
  try {
    localStorage.removeItem(QUEUE_KEY);
  } catch {
    // Ignore.
  }
}

export function todayUTC(): string {
  return dayKeyUTC();
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m === 0) return `${s}s`;
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export const API_OFFLINE_MESSAGE =
  "Leaderboard API is not running — start it with `npm run dev:api`. The game still works offline.";
const API_TIMEOUT_MESSAGE = "Leaderboard request timed out. Try again.";

export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

/** Network-level failures worth retrying later (offline, timeout). */
export function isRetryableError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.message === API_OFFLINE_MESSAGE || e.message === API_TIMEOUT_MESSAGE)
  );
}

async function fetchJson(input: string, init?: RequestInit): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 8000);
  let res: Response;
  try {
    res = await fetch(input, { ...init, signal: ctrl.signal });
  } catch (e) {
    window.clearTimeout(timer);
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(API_TIMEOUT_MESSAGE);
    }
    throw new Error(API_OFFLINE_MESSAGE);
  }
  try {
    // Read as text first: when the API isn't running the dev server answers
    // with an HTML error/fallback page, and res.json() would throw a raw
    // `JSON.parse: unexpected character at line 1 column 1` SyntaxError.
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const message =
        body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : `${API_OFFLINE_MESSAGE} (HTTP ${res.status}).`;
      throw new HttpError(res.status, message, body);
    }
    if (body === null || typeof body !== "object") {
      throw new Error(API_OFFLINE_MESSAGE);
    }
    return body;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function fetchLeaderboard(
  game: LeaderboardGameId,
  day: string = todayUTC(),
  limit = 20,
): Promise<LeaderboardResponse> {
  const params = new URLSearchParams({ game, day, limit: String(limit) });
  const data = (await fetchJson(`/api/leaderboard?${params}`)) as LeaderboardResponse;
  if (!data || typeof data !== "object" || !Array.isArray(data.entries)) {
    throw new Error(API_OFFLINE_MESSAGE);
  }
  return data;
}

export type SubmitResult = { status: "submitted" | "duplicate"; day: string };

export async function submitScore(
  submit: Omit<ScoreSubmit, "clientId"> & { clientId?: string },
): Promise<SubmitResult> {
  const body: ScoreSubmit = {
    ...submit,
    clientId: submit.clientId ?? getClientId(),
  };
  try {
    const data = (await fetchJson("/api/scores", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })) as { duplicate: boolean; entry: { day: string } };
    if (!data || typeof data !== "object" || !data.entry) {
      throw new Error(API_OFFLINE_MESSAGE);
    }
    return { status: data.duplicate ? "duplicate" : "submitted", day: data.entry.day };
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) {
      const entry = (e.body as { entry?: { day?: string } } | null)?.entry;
      return { status: "duplicate", day: typeof entry?.day === "string" ? entry.day : todayUTC() };
    }
    throw e;
  }
}
