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

/** Start timestamp holder: call `start()` on new game, `elapsed()` on solve.
 * `tick()` drives a visible count-up clock (e.g. the meta-row timer pill);
 * `stop()` freezes it on win/loss. The clock keeps running across tab
 * switches by design (no pause on unmount) so daily times stay comparable.
 */
export function createRunTimer(): {
  start(): void;
  stop(): void;
  elapsed(): number;
  tick(cb: (elapsedMs: number) => void): void;
} {
  let startedAt = 0;
  let stoppedAt: number | null = null;
  let interval: number | null = null;
  function clearTimerInterval(): void {
    if (interval !== null) {
      window.clearInterval(interval);
      interval = null;
    }
  }
  function elapsed(): number {
    if (startedAt === 0) return 0;
    const end = stoppedAt ?? performance.now();
    return Math.max(1, Math.round(end - startedAt));
  }
  return {
    start(): void {
      clearTimerInterval();
      startedAt = performance.now();
      stoppedAt = null;
    },
    stop(): void {
      if (startedAt === 0 || stoppedAt !== null) return;
      stoppedAt = performance.now();
      clearTimerInterval();
    },
    elapsed,
    tick(cb: (elapsedMs: number) => void): void {
      clearTimerInterval();
      cb(elapsed());
      interval = window.setInterval(() => {
        if (stoppedAt !== null) {
          clearTimerInterval();
          return;
        }
        cb(elapsed());
      }, 250);
    },
  };
}

/** Bind a run timer to a `#*-timer-value` span; shows `0:00` before start. */
export function bindTimerPill(
  timer: ReturnType<typeof createRunTimer>,
  valueId: string,
  format: (ms: number) => string,
): void {
  const node = document.getElementById(valueId);
  if (!node) return;
  node.textContent = format(0);
  timer.tick((ms) => {
    node.textContent = format(ms);
  });
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
