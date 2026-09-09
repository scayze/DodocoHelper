import { createCrownsGame } from "./crowns/controller.js";
import { createMinesweeperGame } from "./minesweeper/controller.js";
import { createSeasonsGame } from "./seasons/controller.js";
import { createTentsGame } from "./tents/controller.js";
import type { GameDef } from "./types.js";

/** Registry of available minigames. The shell renders tabs from this list. */
export const GAMES: GameDef[] = [
  { id: "crowns", label: "Crowns", create: createCrownsGame },
  { id: "minesweeper", label: "Minesweeper", create: createMinesweeperGame },
  { id: "seasons", label: "Seasons", create: createSeasonsGame },
  { id: "tents", label: "Tents & Trees", create: createTentsGame },
];
