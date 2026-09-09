import type { LeaderboardGameId } from "./types.js";
import { savePendingWin, type PendingWin } from "./api.js";

export interface WinDetail {
  game: LeaderboardGameId;
  durationMs: number;
  moves?: number;
  hintsUsed?: number;
}

export const WIN_EVENT = "dodoco:win";

/** Start timestamp holder: call `startRun()` on new game, `winRun()` on solve. */
export function createRunTimer(): {
  start(): void;
  elapsed(): number;
} {
  let startedAt = 0;
  return {
    start(): void {
      startedAt = performance.now();
    },
    elapsed(): number {
      if (startedAt === 0) return 0;
      return Math.max(1, Math.round(performance.now() - startedAt));
    },
  };
}

/** Broadcast a win so the home leaderboard can offer a one-click submit. */
export function announceWin(detail: WinDetail): void {
  const win: PendingWin = {
    game: detail.game,
    durationMs: Math.max(1, Math.round(detail.durationMs)),
    moves: Math.max(0, Math.round(detail.moves ?? 0)),
    hintsUsed: Math.max(0, Math.round(detail.hintsUsed ?? 0)),
    at: Date.now(),
  };
  savePendingWin(win);
  window.dispatchEvent(new CustomEvent<PendingWin>(WIN_EVENT, { detail: win }));
}
