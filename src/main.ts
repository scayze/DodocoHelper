import "./index.css";
import { createCrownsGame } from "./games/crowns/controller.js";
import { createMinesweeperGame } from "./games/minesweeper/controller.js";
import { createSeasonsGame } from "./games/seasons/controller.js";
import { createTentsGame } from "./games/tents/controller.js";
import type { GameId, GameInstance, ViewId } from "./games/types.js";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const tabButtons: Record<ViewId, HTMLButtonElement> = {
  home: el<HTMLButtonElement>("nav-home"),
  crowns: el<HTMLButtonElement>("game-crowns"),
  minesweeper: el<HTMLButtonElement>("game-minesweeper"),
  seasons: el<HTMLButtonElement>("game-seasons"),
  tents: el<HTMLButtonElement>("game-tents"),
};

const GAME_TITLES: Record<ViewId, string> = {
  home: "Welcome!",
  crowns: "Crowns",
  minesweeper: "Minesweeper",
  seasons: "Seasons",
  tents: "Tents & Trees",
};

const gameTitle = el<HTMLElement>("game-title");
const homeSection = el("home");

const games: Record<GameId, GameInstance> = {
  crowns: createCrownsGame(),
  minesweeper: createMinesweeperGame(),
  seasons: createSeasonsGame(),
  tents: createTentsGame(),
};

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

tabButtons.home.addEventListener("click", () => setView("home"));
tabButtons.crowns.addEventListener("click", () => setView("crowns"));
tabButtons.minesweeper.addEventListener("click", () => setView("minesweeper"));
tabButtons.seasons.addEventListener("click", () => setView("seasons"));
tabButtons.tents.addEventListener("click", () => setView("tents"));

// Initial state: home landing view visible, all games hidden.
games.crowns.unmount();
games.minesweeper.unmount();
games.seasons.unmount();
games.tents.unmount();
homeSection.classList.remove("hidden");
paintTabs();
