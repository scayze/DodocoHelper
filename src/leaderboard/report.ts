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
 * `stop()` freezes it on win/loss. Only actively viewed time counts:
 * `pause()` banks the span so far (tab hidden, other minigame, leaderboard
 * sub-view) and `resume()` starts a fresh span; finished games never resume.
 */
export function createRunTimer(now: () => number = () => performance.now()): {
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  elapsed(): number;
  tick(cb: (elapsedMs: number) => void): void;
} {
  let live = false;
  let stopped = false;
  /** Milliseconds of actively viewed time banked by earlier spans. */
  let banked = 0;
  /** Start of the current active span, or null while paused. */
  let runningSince: number | null = null;
  let interval: number | null = null;
  function clearTimerInterval(): void {
    if (interval !== null) {
      window.clearInterval(interval);
      interval = null;
    }
  }
  function bankActive(): void {
    if (runningSince !== null) {
      banked += Math.max(0, now() - runningSince);
      runningSince = null;
    }
  }
  function elapsed(): number {
    if (!live) return 0;
    const extra = runningSince !== null ? Math.max(0, now() - runningSince) : 0;
    return Math.max(1, Math.round(banked + extra));
  }
  return {
    start(): void {
      clearTimerInterval();
      live = true;
      stopped = false;
      banked = 0;
      runningSince = now();
    },
    stop(): void {
      if (!live || stopped) return;
      bankActive();
      stopped = true;
      clearTimerInterval();
    },
    pause(): void {
      if (!live || stopped || runningSince === null) return;
      bankActive();
    },
    resume(): void {
      if (!live || stopped || runningSince !== null) return;
      runningSince = now();
    },
    elapsed,
    tick(cb: (elapsedMs: number) => void): void {
      clearTimerInterval();
      cb(elapsed());
      interval = window.setInterval(() => {
        if (stopped) {
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
