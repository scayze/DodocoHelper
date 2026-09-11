import "./index.css";
import { GAMES } from "./games/registry.js";
import type { GameId, GameInstance, ViewId } from "./games/types.js";
import {
  NAME_EVENT,
  getDisplayName,
  hasValidName,
  resetDodocoStorage,
} from "./leaderboard/api.js";
import { initGameLeaderboard, initNameGate } from "./leaderboard/view.js";
import { showToast } from "./leaderboard/toast.js";

initNameGate();
initGameLeaderboard("crowns", "crowns");
initGameLeaderboard("minesweeper", "mines");
initGameLeaderboard("seasons", "seasons");
initGameLeaderboard("tents", "tents");

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const tabButtons = {
  home: el<HTMLButtonElement>("nav-home"),
  ...Object.fromEntries(GAMES.map((g) => [g.id, el<HTMLButtonElement>(`game-${g.id}`)])),
} as Record<ViewId, HTMLButtonElement>;

const gameButtons = GAMES.map((g) => tabButtons[g.id]);

const GAME_TITLES = {
  ...Object.fromEntries(GAMES.map((g) => [g.id, g.label])),
} as Record<GameId, string>;

/** Home greets the saved player by name; nameless visitors get the name gate instead. */
function homeTitle(): string {
  const name = getDisplayName();
  return name ? `Welcome ${name}!` : "Welcome!";
}

/** Minigame tabs stay locked until a display name has been saved, but remain fully visible. */
function paintGate(): void {
  const named = hasValidName();
  for (const btn of gameButtons) {
    btn.disabled = !named;
    btn.classList.toggle("cursor-not-allowed", !named);
  }
}

const gameTitle = el<HTMLElement>("game-title");
const homeSection = el("home");
const primaryNav = el<HTMLElement>("primary-nav");

const games = Object.fromEntries(GAMES.map((g) => [g.id, g.create()])) as Record<
  GameId,
  GameInstance
>;

function isGameId(id: ViewId): id is GameId {
  return id !== "home";
}

let activeView: ViewId = "home";

/** Minimal home: named players see only icons + "Welcome X!"; nameless see only the name gate. */
function paintHome(): void {
  const named = hasValidName();
  const onHome = !isGameId(activeView);
  // The gate lives only on the nameless home view: games always hide it,
  // and named players on home see just icons + "Welcome X!".
  homeSection.classList.toggle("hidden", !onHome || named);
  gameTitle.classList.toggle("hidden", onHome && !named);
  // No view/game switching before a name exists: hide the icon nav entirely.
  primaryNav.classList.toggle("hidden", !named);
}

function paintTabs(): void {
  for (const [id, btn] of Object.entries(tabButtons) as Array<[ViewId, HTMLButtonElement]>) {
    const active = id === activeView;
    btn.classList.toggle("font-semibold", active);
    btn.classList.toggle("text-gold-600", active);
    btn.classList.toggle("text-gold-600/50", !active);
  }
  const title = isGameId(activeView) ? GAME_TITLES[activeView] : homeTitle();
  gameTitle.textContent = title;
  document.title = `${title} - Dodoco Helper`;
  paintHome();
}

/** Timestamps of recent valid background taps for the hidden reset. */
const resetTaps: number[] = [];

function setView(id: ViewId): void {
  if (activeView === id) return;
  if (isGameId(id) && !hasValidName()) {
    // Nameless visitors stay on Home and are pointed at the name gate.
    const nameInput = document.getElementById("lb-gate-name") as HTMLInputElement | null;
    const gateStatus = document.getElementById("lb-gate-status");
    if (gateStatus) gateStatus.textContent = "Tell us your name first to start playing.";
    nameInput?.focus();
    return;
  }
  if (isGameId(activeView)) {
    games[activeView].pauseClock();
    games[activeView].unmount();
  } else {
    homeSection.classList.add("hidden");
  }
  // Each game owns its sections: crowns owns the upload actions + solver
  // stage, minesweeper and seasons own their own board containers.
  document.getElementById("top")?.classList.remove("has-result");
  activeView = id;
  // Taps across views never combine toward the hidden reset.
  resetTaps.length = 0;
  if (isGameId(id)) {
    games[id].mount();
    games[id].resumeClock();
  } else {
    homeSection.classList.remove("hidden");
  }
  paintTabs();
}

for (const id of Object.keys(tabButtons) as ViewId[]) {
  tabButtons[id].addEventListener("click", () => setView(id));
}

/**
 * Hidden reset: 5 taps on the strict empty background (directly on the page
 * or main padding, never on panels/buttons/inputs) within 2s wipes the
 * dodoco-owned localStorage keys and reloads so a visitor can reregister.
 * Home view only; silent apart from a brief toast.
 */
function initHiddenReset(): void {
  const WINDOW_MS = 2000;
  const REQUIRED_TAPS = 5;
  let resetting = false;

  function noteTap(): void {
    if (resetting || isGameId(activeView)) return;
    const now = Date.now();
    resetTaps.push(now);
    while (resetTaps.length > 0 && now - resetTaps[0]! > WINDOW_MS) resetTaps.shift();
    if (resetTaps.length >= REQUIRED_TAPS) {
      resetTaps.length = 0;
      resetting = true;
      showToast("Resetting…", 800);
      window.setTimeout(() => {
        resetDodocoStorage();
        location.reload();
      }, 700);
    }
  }

  for (const selector of [".parchment-page", "#top"]) {
    document.querySelector(selector)?.addEventListener("click", (e) => {
      // Strict empty area: only taps whose target IS the background itself.
      if (e.target !== e.currentTarget) return;
      noteTap();
    });
  }
}

// A freshly confirmed name updates the greeting and unlocks the games.
window.addEventListener(NAME_EVENT, () => {
  paintGate();
  paintTabs();
});

// Daily clocks only run while actively viewed: hidden tabs, minimized
// windows and app switches freeze every game; returning resumes the active
// view (finished games stay frozen via the timer's stopped state).
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    for (const game of Object.values(games)) game.pauseClock();
  } else if (isGameId(activeView)) {
    games[activeView].resumeClock();
  }
});

// Initial state: home landing view visible, all games hidden.
for (const game of Object.values(games)) game.unmount();
initHiddenReset();
paintGate();
paintTabs();
