import "./index.css";
import { createCrownsGame } from "./games/crowns/controller.js";
import { createMinesweeperGame } from "./games/minesweeper/controller.js";
import { createSeasonsGame } from "./games/seasons/controller.js";
import { createTentsGame } from "./games/tents/controller.js";
import type { GameId, GameInstance } from "./games/types.js";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const tabButtons: Record<GameId, HTMLButtonElement> = {
  crowns: el<HTMLButtonElement>("game-crowns"),
  minesweeper: el<HTMLButtonElement>("game-minesweeper"),
  seasons: el<HTMLButtonElement>("game-seasons"),
  tents: el<HTMLButtonElement>("game-tents"),
};

const games: Record<GameId, GameInstance> = {
  crowns: createCrownsGame(),
  minesweeper: createMinesweeperGame(),
  seasons: createSeasonsGame(),
  tents: createTentsGame(),
};

let activeGame: GameId = "crowns";

function paintTabs(): void {
  for (const [id, btn] of Object.entries(tabButtons) as Array<[GameId, HTMLButtonElement]>) {
    const active = id === activeGame;
    btn.classList.toggle("font-semibold", active);
    btn.classList.toggle("text-gold-600", active);
    btn.classList.toggle("text-gold-600/50", !active);
  }
}

function setGame(id: GameId): void {
  if (activeGame === id) return;
  games[activeGame].unmount();
  // Each game owns its sections: crowns owns the upload actions + solver
  // stage, minesweeper and seasons own their own board containers.
  document.getElementById("top")?.classList.remove("has-result");
  activeGame = id;
  games[activeGame].mount();
  paintTabs();
}

tabButtons.crowns.addEventListener("click", () => setGame("crowns"));
tabButtons.minesweeper.addEventListener("click", () => setGame("minesweeper"));
tabButtons.seasons.addEventListener("click", () => setGame("seasons"));
tabButtons.tents.addEventListener("click", () => setGame("tents"));

// Initial state: crowns visible, other games hidden.
games.minesweeper.unmount();
games.seasons.unmount();
games.tents.unmount();
games.crowns.mount();
paintTabs();
