import "./index.css";
import { GAMES } from "./games/registry.js";
import type { GameId, GameInstance, ViewId } from "./games/types.js";
import { initLeaderboard } from "./leaderboard/view.js";

initLeaderboard();

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const tabButtons = {
  home: el<HTMLButtonElement>("nav-home"),
  ...Object.fromEntries(GAMES.map((g) => [g.id, el<HTMLButtonElement>(`game-${g.id}`)])),
} as Record<ViewId, HTMLButtonElement>;

const GAME_TITLES = {
  home: "Welcome!",
  ...Object.fromEntries(GAMES.map((g) => [g.id, g.label])),
} as Record<ViewId, string>;

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
  gameTitle.textContent = GAME_TITLES[activeView];
  document.title = `${GAME_TITLES[activeView]} - Dodoco Helper`;
}

function setView(id: ViewId): void {
  if (activeView === id) return;
  if (isGameId(activeView)) {
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
  } else {
    homeSection.classList.remove("hidden");
  }
  paintTabs();
}

for (const id of Object.keys(tabButtons) as ViewId[]) {
  tabButtons[id].addEventListener("click", () => setView(id));
}

// Initial state: home landing view visible, all games hidden.
for (const game of Object.values(games)) game.unmount();
homeSection.classList.remove("hidden");
paintTabs();
