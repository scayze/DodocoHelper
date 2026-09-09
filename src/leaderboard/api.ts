import {
  dayKeyUTC,
  type LeaderboardGameId,
  type LeaderboardResponse,
  type ScoreSubmit,
} from "./types.js";

const CLIENT_KEY = "dodoco:clientId";
const NAME_KEY = "dodoco:displayName";
const PENDING_KEY = "dodoco:pendingWin";

export interface PendingWin {
  game: LeaderboardGameId;
  durationMs: number;
  moves: number;
  hintsUsed: number;
  at: number;
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

export function getDisplayName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setDisplayName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Ignore storage failures; submit still works for this session.
  }
}

export function savePendingWin(win: PendingWin): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(win));
  } catch {
    // Ignore.
  }
}

export function loadPendingWin(): PendingWin | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingWin;
    if (typeof parsed.durationMs !== "number" || typeof parsed.game !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingWin(): void {
  try {
    localStorage.removeItem(PENDING_KEY);
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

const API_OFFLINE_MESSAGE =
  "Leaderboard API is not running — start it with `npm run dev:api`. The game still works offline.";

async function fetchJson(input: string, init?: RequestInit): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 8000);
  let res: Response;
  try {
    res = await fetch(input, { ...init, signal: ctrl.signal });
  } catch (e) {
    window.clearTimeout(timer);
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("Leaderboard request timed out. Try again.");
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
      throw new Error(message);
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

export async function submitScore(
  submit: Omit<ScoreSubmit, "clientId"> & { clientId?: string },
): Promise<{ improved: boolean; day: string }> {
  const body: ScoreSubmit = {
    ...submit,
    clientId: submit.clientId ?? getClientId(),
  };
  const data = (await fetchJson("/api/scores", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })) as { improved: boolean; entry: { day: string } };
  if (!data || typeof data !== "object" || !data.entry) {
    throw new Error(API_OFFLINE_MESSAGE);
  }
  return { improved: data.improved, day: data.entry.day };
}
