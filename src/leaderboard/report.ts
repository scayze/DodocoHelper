import { winScoreFor, type LeaderboardGameId } from "./types.js";
import {
  getDisplayName,
  hasValidName,
  isRetryableError,
  queueWin,
  submitScore,
} from "./api.js";
import { showToast } from "./toast.js";
import { createEventHub } from "../events.js";

export interface WinDetail {
  game: LeaderboardGameId;
  durationMs: number;
  moves?: number;
  hintsUsed?: number;
  /** Primary metric; defaults to the win value when omitted. */
  score?: number;
  /** False for a finished-but-unsolved daily. Defaults to true. */
  won?: boolean;
}

/** Fired after a finished daily is submitted or queued (per game). */
export const winEvents = createEventHub<WinDetail>();

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
  /** Restore a persisted run: live at `ms` banked, paused. The active span
   * starts on the next resume() (e.g. the shell's resumeClock on mount), so
   * only viewed time after reload counts. Finished games just call stop(). */
  restoreElapsed(ms: number): void;
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
  /** Ticks the bound pill; null when no display is bound (see tick). */
  let tickCb: ((elapsedMs: number) => void) | null = null;
  function clearTimerInterval(): void {
    if (interval !== null) {
      window.clearInterval(interval);
      interval = null;
    }
  }
  /** Recreate the display interval only while a tick callback is bound and
   * the span is actually running. Pause/stop clear it, so paused or finished
   * games never keep painting (the old design ticked every 250ms forever).
   */
  function ensureInterval(): void {
    clearTimerInterval();
    if (tickCb !== null && live && !stopped && runningSince !== null) {
      interval = window.setInterval(() => {
        if (stopped) {
          clearTimerInterval();
          return;
        }
        tickCb?.(elapsed());
      }, 250);
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
      ensureInterval();
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
      clearTimerInterval();
    },
    resume(): void {
      if (!live || stopped || runningSince !== null) return;
      runningSince = now();
      ensureInterval();
    },
    restoreElapsed(ms: number): void {
      clearTimerInterval();
      live = true;
      stopped = false;
      banked = Math.max(1, Math.round(ms));
      runningSince = null;
    },
    elapsed,
    tick(cb: (elapsedMs: number) => void): void {
      tickCb = cb;
      cb(elapsed());
      ensureInterval();
    },
  };
}

/** Bind a run timer to a `#*-timer-value` span; paints its current value.
 * Only a running span ticks: start/resume (re)create the interval, pause/
 * stop clear it, so a paused timer can never clobber a freshly bound one.
 */
export function bindTimerPill(
  timer: ReturnType<typeof createRunTimer>,
  valueId: string,
  format: (ms: number) => string,
): void {
  const node = document.getElementById(valueId);
  if (!node) return;
  timer.tick((ms) => {
    node.textContent = format(ms);
  });
}

/**
 * Finished-daily routing (win or loss): named players submit immediately
 * (failure re-queues for a later flush); nameless players accumulate
 * earliest-per-game queue entries until they pick a name on the Home board.
 */
export function announceResult(detail: WinDetail): void {
  const win = {
    game: detail.game,
    durationMs: Math.max(1, Math.round(detail.durationMs)),
    moves: Math.max(0, Math.round(detail.moves ?? 0)),
    hintsUsed: Math.max(0, Math.round(detail.hintsUsed ?? 0)),
    score: Math.max(0, Math.round(detail.score ?? winScoreFor(detail.game))),
    won: detail.won ?? true,
  };
  if (!hasValidName()) {
    queueWin(win);
    winEvents.dispatch(win);
    return;
  }
  const displayName = getDisplayName();
  void submitScore({ ...win, displayName })
    .then(({ status }) => {
      showToast(status === "duplicate" ? "Already submitted today." : "Score submitted.");
      winEvents.dispatch(win);
    })
    .catch((e: unknown) => {
      queueWin(win);
      showToast(
        isRetryableError(e) ? "No connection — score will retry." : "Submit failed — score queued.",
      );
      winEvents.dispatch(win);
    });
}

/** Win-only alias for games that cannot fail (crowns, tents). */
export function announceWin(detail: WinDetail): void {
  announceResult({ ...detail, score: detail.score ?? winScoreFor(detail.game), won: true });
}
