import "./index.css";
import { GAMES } from "./games/registry.js";
import type { GameId, GameInstance, ViewId } from "./games/types.js";
import { NAME_EVENT, getDisplayName, hasValidName } from "./leaderboard/api.js";
import { initGameLeaderboard, initNameGate } from "./leaderboard/view.js";
import { pickRandomQuote } from "./quotes.js";

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

/** Home greets returning players by name; everyone else gets "Welcome!". */
function homeTitle(): string {
  const name = getDisplayName();
  return name ? `Welcome ${name}!` : "Welcome!";
}

/** Random quote of the day, re-rolled on every Home visit. */
function paintQuote(): void {
  const quote = document.getElementById("quote");
  if (quote) quote.textContent = `\u201C${pickRandomQuote()}\u201D`;
}

/** Minigame tabs stay locked until a display name has been saved. */
function paintGate(): void {
  const named = hasValidName();
  for (const btn of gameButtons) {
    btn.disabled = !named;
    btn.classList.toggle("opacity-40", !named);
    btn.classList.toggle("cursor-not-allowed", !named);
  }
}

const gameTitle = el<HTMLElement>("game-title");
const homeSection = el("home");

const games = Object.fromEntries(GAMES.map((g) => [g.id, g.create()])) as Record<
  GameId,
  GameInstance
>;

function isGameId(id: ViewId): id is GameId {
  return id !== "home";
}

let activeView: ViewId = "home";

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
}

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
  if (isGameId(id)) {
    games[id].mount();
    games[id].resumeClock();
  } else {
    homeSection.classList.remove("hidden");
    paintQuote();
  }
  paintTabs();
}

for (const id of Object.keys(tabButtons) as ViewId[]) {
  tabButtons[id].addEventListener("click", () => setView(id));
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
homeSection.classList.remove("hidden");
paintQuote();
paintGate();
paintTabs();
