import type { LeaderboardGameId } from "./types.js";
import {
  getDisplayName,
  hasValidName,
  isRetryableError,
  queueWin,
  submitScore,
} from "./api.js";
import { showToast } from "./toast.js";

export interface WinDetail {
  game: LeaderboardGameId;
  durationMs: number;
  moves?: number;
  hintsUsed?: number;
}

export const WIN_EVENT = "dodoco:win";

/** Start timestamp holder: call `start()` on new game, `elapsed()` on solve. */
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

/**
 * Win routing: named players submit immediately (failure re-queues for a
 * later flush); nameless players accumulate earliest-per-game queue entries
 * until they pick a name on the Home board.
 */
export function announceWin(detail: WinDetail): void {
  const win = {
    game: detail.game,
    durationMs: Math.max(1, Math.round(detail.durationMs)),
    moves: Math.max(0, Math.round(detail.moves ?? 0)),
    hintsUsed: Math.max(0, Math.round(detail.hintsUsed ?? 0)),
  };
  if (!hasValidName()) {
    queueWin(win);
    window.dispatchEvent(new CustomEvent(WIN_EVENT, { detail: win }));
    return;
  }
  const displayName = getDisplayName();
  void submitScore({ ...win, displayName })
    .then(({ status }) => {
      showToast(status === "duplicate" ? "Already submitted today." : "Score submitted.");
      window.dispatchEvent(new CustomEvent(WIN_EVENT, { detail: win }));
    })
    .catch((e: unknown) => {
      queueWin(win);
      showToast(
        isRetryableError(e) ? "No connection — score will retry." : "Submit failed — score queued.",
      );
      window.dispatchEvent(new CustomEvent(WIN_EVENT, { detail: win }));
    });
}
