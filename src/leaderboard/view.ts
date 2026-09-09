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
import { WIN_EVENT } from "./report.js";
import { showToast } from "./toast.js";
import {
  LEADERBOARD_GAMES,
  isValidDay,
  shiftDayKey,
  type LeaderboardGameId,
} from "./types.js";

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

/**
 * Home leaderboard. Nameless visitors see only the name gate; once a name is
 * saved the daily board shows. Scores are never submitted by hand: named wins
 * post immediately from the game, nameless wins queue until the name is set.
 */
export function initLeaderboard(): void {
  const gate = el<HTMLElement>("lb-gate");
  const gateName = el<HTMLInputElement>("lb-gate-name");
  const gateConfirm = el<HTMLButtonElement>("lb-gate-confirm");
  const gateStatus = el<HTMLParagraphElement>("lb-gate-status");
  const board = el<HTMLElement>("lb-board");
  const list = el<HTMLOListElement>("lb-list");
  const status = el<HTMLParagraphElement>("lb-status");
  const dayLabel = el<HTMLElement>("lb-day");
  const prevBtn = el<HTMLButtonElement>("lb-prev");
  const nextBtn = el<HTMLButtonElement>("lb-next");
  const tabs = el<HTMLElement>("lb-tabs");
  if (
    !gate ||
    !gateName ||
    !gateConfirm ||
    !gateStatus ||
    !board ||
    !list ||
    !status ||
    !dayLabel ||
    !prevBtn ||
    !nextBtn ||
    !tabs
  ) {
    return;
  }
  const gateEl: HTMLElement = gate;
  const gateNameEl: HTMLInputElement = gateName;
  const gateConfirmEl: HTMLButtonElement = gateConfirm;
  const gateStatusEl: HTMLParagraphElement = gateStatus;
  const boardEl: HTMLElement = board;
  const listEl: HTMLOListElement = list;
  const statusEl: HTMLParagraphElement = status;
  const dayEl: HTMLElement = dayLabel;
  const prevEl: HTMLButtonElement = prevBtn;
  const nextEl: HTMLButtonElement = nextBtn;
  const tabsEl: HTMLElement = tabs;

  let activeGame: LeaderboardGameId = "crowns";
  let loading = false;
  let flushing = false;
  let viewDay = todayUTC();

  /** Refresh the subtitle and clamp forward navigation at today. */
  function paintDay(): void {
    dayEl.textContent = viewDay;
    nextEl.disabled = viewDay >= todayUTC();
  }

  function setDay(day: string): void {
    if (!isValidDay(day) || day > todayUTC() || day === viewDay) return;
    viewDay = day;
    paintDay();
    void load();
  }

  function showGate(): void {
    gateEl.classList.remove("hidden");
    boardEl.classList.add("hidden");
    boardEl.classList.remove("flex");
  }

  function showBoard(): void {
    gateEl.classList.add("hidden");
    boardEl.classList.remove("hidden");
    boardEl.classList.add("flex");
  }

  function paintTabs(): void {
    for (const btn of tabsEl.querySelectorAll<HTMLButtonElement>("[data-game]")) {
      const active = btn.dataset["game"] === activeGame;
      btn.classList.toggle("font-semibold", true);
      btn.setAttribute("aria-selected", active ? "true" : "false");
      btn.style.opacity = active ? "1" : "0.55";
    }
  }

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    statusEl.textContent = "";
    try {
      const data = await fetchLeaderboard(activeGame, viewDay, 20);
      listEl.replaceChildren();
      if (data.entries.length === 0) {
        const li = document.createElement("li");
        li.className =
          "flex items-center gap-[13px] rounded-xl bg-white/70 px-[18px] py-[13px] shadow-sm";
        const span = document.createElement("span");
        span.className = "min-w-0 flex-1 truncate text-[15px] font-semibold text-night-800/70";
        span.textContent =
          viewDay === todayUTC()
            ? `No ${gameLabel(activeGame)} times today yet — be the first.`
            : `No ${gameLabel(activeGame)} times on ${viewDay} yet.`;
        li.appendChild(span);
        listEl.appendChild(li);
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
          listEl.appendChild(li);
        });
      }
    } catch (e) {
      listEl.replaceChildren();
      const li = document.createElement("li");
      li.className =
        "flex items-center gap-[13px] rounded-xl bg-white/70 px-[18px] py-[13px] shadow-sm";
      const span = document.createElement("span");
      span.className = "min-w-0 flex-1 truncate text-[15px] font-semibold text-night-800/70";
      span.textContent = "Leaderboard is offline right now — your game still works.";
      li.appendChild(span);
      listEl.appendChild(li);
      statusEl.textContent = e instanceof Error ? e.message : "Could not load the board.";
    } finally {
      loading = false;
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

  function confirmName(): void {
    const raw = gateNameEl.value;
    if (!isValidDisplayName(raw)) {
      gateStatusEl.textContent = "Pick a name with 2–20 characters (no < or >).";
      gateNameEl.focus();
      return;
    }
    if (flushing) return;
    flushing = true;
    gateConfirmEl.disabled = true;
    gateStatusEl.textContent = "Saving…";
    const displayName = raw.trim().replace(/\s+/g, " ");
    setDisplayName(displayName);
    void flushQueue(displayName)
      .then(({ submitted }) => {
        viewDay = todayUTC();
        showBoard();
        paintTabs();
        paintDay();
        if (submitted > 0) {
          showToast(submitted === 1 ? "Score submitted." : `${submitted} scores submitted.`);
        }
        return load();
      })
      .catch(() => {
        showBoard();
        paintTabs();
        paintDay();
        return load();
      })
      .finally(() => {
        flushing = false;
        gateConfirmEl.disabled = false;
        gateStatusEl.textContent = "";
      });
  }

  gateConfirmEl.addEventListener("click", confirmName);
  gateNameEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      confirmName();
    }
  });

  prevEl.addEventListener("click", () => setDay(shiftDayKey(viewDay, -1)));
  nextEl.addEventListener("click", () => setDay(shiftDayKey(viewDay, 1)));

  tabsEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-game]");
    if (!btn || !btn.dataset["game"]) return;
    const game = btn.dataset["game"] as LeaderboardGameId;
    if (!(LEADERBOARD_GAMES as readonly string[]).includes(game)) return;
    if (game === activeGame) return;
    activeGame = game;
    paintTabs();
    void load();
  });

  // Named wins post from the game itself; jump back to today (fresh scores
  // always land there) and refresh the visible board. Nameless wins only
  // grow the hidden queue.
  window.addEventListener(WIN_EVENT, () => {
    if (boardEl.classList.contains("hidden")) return;
    const today = todayUTC();
    if (viewDay !== today) {
      viewDay = today;
      paintDay();
    }
    void load();
  });

  if (hasValidName()) {
    viewDay = todayUTC();
    showBoard();
    paintTabs();
    paintDay();
    // Retry anything left queued (e.g. an earlier offline submit) now that
    // the board — and presumably connectivity — is back in view.
    if (loadQueuedWins().some((w) => w.day === viewDay)) {
      void flushQueue(getDisplayName()).then(() => load());
    } else {
      void load();
    }
  } else {
    showGate();
  }
}
