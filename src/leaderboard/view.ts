import {
  clearPendingWin,
  fetchLeaderboard,
  formatDuration,
  getDisplayName,
  loadPendingWin,
  setDisplayName,
  submitScore,
  todayUTC,
  type PendingWin,
} from "./api.js";
import { WIN_EVENT } from "./report.js";
import { LEADERBOARD_GAMES, type LeaderboardGameId } from "./types.js";

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

/** Mount the home leaderboard. Safe to call once; no-ops when DOM is absent. */
export function initLeaderboard(): void {
  const list = el<HTMLOListElement>("lb-list");
  const status = el<HTMLParagraphElement>("lb-status");
  const dayLabel = el<HTMLElement>("lb-day");
  const tabs = el<HTMLElement>("lb-tabs");
  const nameInput = el<HTMLInputElement>("lb-name");
  const submitButton = el<HTMLButtonElement>("lb-submit");
  const pendingBox = el<HTMLElement>("lb-pending");
  if (!list || !status || !tabs || !nameInput || !submitButton || !pendingBox) return;
  const listEl: HTMLOListElement = list;
  const statusEl: HTMLParagraphElement = status;
  const tabsEl: HTMLElement = tabs;
  const nameEl: HTMLInputElement = nameInput;
  const submitEl: HTMLButtonElement = submitButton;
  const pendingEl: HTMLElement = pendingBox;

  let activeGame: LeaderboardGameId = "crowns";
  let loading = false;
  const day = todayUTC();
  if (dayLabel) dayLabel.textContent = day;

  const savedName = getDisplayName();
  if (savedName) nameEl.value = savedName;

  function paintTabs(): void {
    for (const btn of tabsEl.querySelectorAll<HTMLButtonElement>("[data-game]")) {
      const active = btn.dataset["game"] === activeGame;
      btn.classList.toggle("font-semibold", true);
      btn.setAttribute("aria-selected", active ? "true" : "false");
      btn.style.opacity = active ? "1" : "0.55";
    }
  }

  function renderPending(): void {
    const pending: PendingWin | null = loadPendingWin();
    pendingEl.replaceChildren();
    const showSubmit = pending !== null;
    submitEl.disabled = !showSubmit;
    if (!pending) {
      pendingEl.classList.add("hidden");
      pendingEl.classList.remove("flex");
      return;
    }
    pendingEl.classList.remove("hidden");
    pendingEl.classList.add("flex");
    const text = document.createElement("p");
    text.className = "text-[15px] font-semibold text-night-900";
    text.textContent =
      pending.game === activeGame
        ? `Your ${gameLabel(pending.game)} win today: ${formatDuration(pending.durationMs)} — enter a nickname and submit.`
        : `Your ${gameLabel(pending.game)} win is ready — switch to ${gameLabel(pending.game)} to submit it.`;
    pendingEl.appendChild(text);
  }

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    statusEl.textContent = "";
    try {
      const board = await fetchLeaderboard(activeGame, day, 20);
      listEl.replaceChildren();
      if (board.entries.length === 0) {
        const li = document.createElement("li");
        li.className =
          "flex items-center gap-[13px] rounded-xl bg-white/70 px-[18px] py-[13px] shadow-sm";
        const span = document.createElement("span");
        span.className = "min-w-0 flex-1 truncate text-[15px] font-semibold text-night-800/70";
        span.textContent = `No ${gameLabel(activeGame)} times today yet — be the first.`;
        li.appendChild(span);
        listEl.appendChild(li);
      } else {
        board.entries.forEach((entry, index) => {
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

  tabsEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-game]");
    if (!btn || !btn.dataset["game"]) return;
    const game = btn.dataset["game"] as LeaderboardGameId;
    if (!(LEADERBOARD_GAMES as readonly string[]).includes(game)) return;
    if (game === activeGame) return;
    activeGame = game;
    paintTabs();
    renderPending();
    void load();
  });

  nameEl.addEventListener("input", () => {
    setDisplayName(nameEl.value);
  });

  submitEl.addEventListener("click", () => {
    const pending = loadPendingWin();
    if (!pending) return;
    const displayName = nameEl.value.trim().replace(/\s+/g, " ");
    if (displayName.length < 2) {
      statusEl.textContent = "Enter a nickname (2–20 characters) to submit.";
      nameEl.focus();
      return;
    }
    submitEl.disabled = true;
    statusEl.textContent = "Submitting…";
    void submitScore({
      game: pending.game,
      displayName,
      durationMs: pending.durationMs,
      moves: pending.moves,
      hintsUsed: pending.hintsUsed,
    })
      .then(({ improved }) => {
        clearPendingWin();
        renderPending();
        statusEl.textContent = improved
          ? `Submitted — ${formatDuration(pending.durationMs)} on today's ${gameLabel(pending.game)} board.`
          : "Kept your faster time — board reloaded.";
        if (pending.game !== activeGame) {
          activeGame = pending.game;
          paintTabs();
        }
        return load();
      })
      .catch((e: unknown) => {
        statusEl.textContent = e instanceof Error ? e.message : "Submit failed.";
        renderPending();
      });
  });

  window.addEventListener(WIN_EVENT, () => {
    renderPending();
    statusEl.textContent = "Win recorded — head Home to submit it to today's board.";
  });

  paintTabs();
  renderPending();
  void load();
}
