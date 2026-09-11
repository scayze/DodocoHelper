import {
  dropQueuedWin,
  fetchLeaderboard,
  formatDuration,
  getDisplayName,
  hasValidName,
  isRetryableError,
  isValidDisplayName,
  loadQueuedWins,
  setDisplayName,
  submitScore,
  todayUTC,
} from "./api.js";
import { WIN_EVENT, type WinDetail } from "./report.js";
import { showToast } from "./toast.js";
import { isValidDay, shiftDayKey, type LeaderboardGameId } from "./types.js";

/** Dispatched on window when a minigame flips between grid and board. */
export const BOARD_EVENT = "dodoco:board";

export interface BoardDetail {
  game: LeaderboardGameId;
  showingBoard: boolean;
}

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function gameLabel(game: LeaderboardGameId): string {
  switch (game) {
    case "crowns":
      return "Crowns";
    case "minesweeper":
      return "Minesweeper";
    case "seasons":
      return "Seasons";
    case "tents":
      return "Tents";
  }
}

/** Submit queued wins oldest-first; stale days dropped, duplicates dropped. */
async function flushQueue(displayName: string): Promise<{ submitted: number }> {
  const today = todayUTC();
  const fresh = loadQueuedWins().filter((w) => w.day === today);
  let submitted = 0;
  for (const win of fresh) {
    try {
      const { status } = await submitScore({
        game: win.game,
        displayName,
        durationMs: win.durationMs,
        moves: win.moves,
        hintsUsed: win.hintsUsed,
      });
      dropQueuedWin(win.game);
      if (status === "submitted") submitted++;
    } catch (e) {
      if (e instanceof Error && !isRetryableError(e)) {
        // Rejected for good (e.g. invalid payload): never retryable.
        dropQueuedWin(win.game);
        continue;
      }
      // Offline/timeout: keep the rest queued, stop to avoid N timeouts.
      break;
    }
  }
  return { submitted };
}

/**
 * Home name gate. Stays on the landing view: visitors pick a name once, which
 * unlocks the minigame tabs (see `src/main.ts`) and flushes any queued wins.
 */
export function initNameGate(): void {
  const gateName = el<HTMLInputElement>("lb-gate-name");
  const gateConfirm = el<HTMLButtonElement>("lb-gate-confirm");
  const gateStatus = el<HTMLParagraphElement>("lb-gate-status");
  if (!gateName || !gateConfirm || !gateStatus) return;
  const nameEl: HTMLInputElement = gateName;
  const confirmEl: HTMLButtonElement = gateConfirm;
  const statusEl: HTMLParagraphElement = gateStatus;

  let flushing = false;

  function confirmName(): void {
    const raw = nameEl.value;
    if (!isValidDisplayName(raw)) {
      statusEl.textContent = "Pick a name with 2–20 characters (no < or >).";
      nameEl.focus();
      return;
    }
    if (flushing) return;
    flushing = true;
    confirmEl.disabled = true;
    statusEl.textContent = "Saving…";
    const displayName = raw.trim().replace(/\s+/g, " ");
    // Dispatches NAME_EVENT: main.ts hides the gate and shows "Welcome X!".
    setDisplayName(displayName);
    void flushQueue(displayName)
      .then(({ submitted }) => {
        statusEl.textContent = "";
        if (submitted > 0) {
          showToast(submitted === 1 ? "Score submitted." : `${submitted} scores submitted.`);
        }
      })
      .catch(() => {
        statusEl.textContent = "";
      })
      .finally(() => {
        flushing = false;
        confirmEl.disabled = false;
      });
  }

  confirmEl.addEventListener("click", confirmName);
  nameEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      confirmName();
    }
  });

  if (hasValidName()) {
    // Retry anything left queued (e.g. an earlier offline submit) now that
    // a named player is back. The gate itself stays hidden (see main.ts).
    if (loadQueuedWins().some((w) => w.day === todayUTC())) {
      void flushQueue(getDisplayName());
    }
  }
}

export interface GameBoardElements {
  toggle: HTMLButtonElement;
  gameView: HTMLElement;
  boardView: HTMLElement;
  list: HTMLOListElement;
  status: HTMLParagraphElement;
  day: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
}

function resolveGameBoard(prefix: string): GameBoardElements | null {
  const toggle = el<HTMLButtonElement>(`${prefix}-view-toggle`);
  const gameView = el<HTMLElement>(`${prefix}-game-view`);
  const boardView = el<HTMLElement>(`${prefix}-lb-view`);
  const list = el<HTMLOListElement>(`${prefix}-lb-list`);
  const status = el<HTMLParagraphElement>(`${prefix}-lb-status`);
  const day = el<HTMLElement>(`${prefix}-lb-day`);
  const prev = el<HTMLButtonElement>(`${prefix}-lb-prev`);
  const next = el<HTMLButtonElement>(`${prefix}-lb-next`);
  if (!toggle || !gameView || !boardView || !list || !status || !day || !prev || !next) {
    return null;
  }
  return { toggle, gameView, boardView, list, status, day, prev, next };
}

/**
 * Per-minigame leaderboard. One instance per game page shows only that game's
 * board; the toggle button (always visible) swaps the game grid and the board.
 */
export function initGameLeaderboard(game: LeaderboardGameId, prefix: string): void {
  const nodes = resolveGameBoard(prefix);
  if (!nodes) return;
  const { toggle, gameView, boardView, list, status, day, prev, next } = nodes;

  let viewDay = todayUTC();
  let loading = false;
  let loaded = false;
  let showingBoard = false;

  function boardVisible(): boolean {
    return showingBoard;
  }

  function paintDay(): void {
    day.textContent = viewDay;
    next.disabled = viewDay >= todayUTC();
  }

  function paintToggle(): void {
    const label = showingBoard ? "Show game" : "Show leaderboard";
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("title", label);
    toggle.setAttribute("aria-expanded", showingBoard ? "true" : "false");
  }

  function setShowing(showBoard: boolean): void {
    showingBoard = showBoard;
    gameView.classList.toggle("hidden", showBoard);
    boardView.classList.toggle("hidden", !showBoard);
    boardView.classList.toggle("flex", showBoard);
    paintToggle();
    window.dispatchEvent(
      new CustomEvent<BoardDetail>(BOARD_EVENT, { detail: { game, showingBoard } }),
    );
    if (showBoard && !loaded) {
      void load();
    }
  }

  function setDay(nextDay: string): void {
    if (!isValidDay(nextDay) || nextDay > todayUTC() || nextDay === viewDay) return;
    viewDay = nextDay;
    paintDay();
    void load();
  }

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    status.textContent = "";
    try {
      const data = await fetchLeaderboard(game, viewDay, 20);
      loaded = true;
      list.replaceChildren();
      if (data.entries.length === 0) {
        const li = document.createElement("li");
        li.className =
          "flex items-center gap-[13px] rounded-xl bg-white/70 px-[18px] py-[13px] shadow-sm";
        const span = document.createElement("span");
        span.className = "min-w-0 flex-1 truncate text-[15px] font-semibold text-night-800/70";
        span.textContent =
          viewDay === todayUTC()
            ? `No ${gameLabel(game)} times today yet — be the first.`
            : `No ${gameLabel(game)} times on ${viewDay} yet.`;
        li.appendChild(span);
        list.appendChild(li);
      } else {
        data.entries.forEach((entry, index) => {
          const li = document.createElement("li");
          li.className =
            "flex items-center gap-[13px] rounded-xl bg-white/70 px-[18px] py-[13px] shadow-sm";
          const rank = document.createElement("span");
          rank.className = "w-[28px] shrink-0 text-center text-[15px] font-bold text-gold-600";
          rank.textContent = String(index + 1);
          const avatar = document.createElement("span");
          avatar.className = "h-[32px] w-[32px] shrink-0 rounded-full bg-gold-600/20";
          avatar.setAttribute("aria-hidden", "true");
          const name = document.createElement("span");
          name.className = "min-w-0 flex-1 truncate text-[15px] font-semibold";
          name.textContent = entry.displayName;
          const time = document.createElement("span");
          time.className = "shrink-0 text-[15px] font-bold tabular-nums";
          time.textContent = formatDuration(entry.durationMs);
          li.append(rank, avatar, name, time);
          list.appendChild(li);
        });
      }
    } catch (e) {
      list.replaceChildren();
      const li = document.createElement("li");
      li.className =
        "flex items-center gap-[13px] rounded-xl bg-white/70 px-[18px] py-[13px] shadow-sm";
      const span = document.createElement("span");
      span.className = "min-w-0 flex-1 truncate text-[15px] font-semibold text-night-800/70";
      span.textContent = "Leaderboard is offline right now — your game still works.";
      li.appendChild(span);
      list.appendChild(li);
      status.textContent = e instanceof Error ? e.message : "Could not load the board.";
    } finally {
      loading = false;
    }
  }

  toggle.addEventListener("click", () => setShowing(!boardVisible()));
  prev.addEventListener("click", () => setDay(shiftDayKey(viewDay, -1)));
  next.addEventListener("click", () => setDay(shiftDayKey(viewDay, 1)));

  // Named wins post from the game itself; jump back to today (fresh scores
  // always land there) and refresh when this game's board is showing.
  window.addEventListener(WIN_EVENT, (e) => {
    const detail = (e as CustomEvent<WinDetail>).detail;
    if (!detail || detail.game !== game) return;
    const today = todayUTC();
    if (viewDay !== today) {
      viewDay = today;
      paintDay();
    }
    if (boardVisible()) {
      void load();
    } else {
      // Board is hidden: force a reload next time it opens so the fresh
      // score is never stale.
      loaded = false;
    }
  });

  paintDay();
  paintToggle();
}
