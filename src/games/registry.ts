import type { GameDef } from "./types.js";

/** Registry of available minigames. Add future games here; the shell renders tabs from this list. */
export const GAMES: GameDef[] = [
  { id: "crowns", label: "Crowns" },
  { id: "minesweeper", label: "Minesweeper" },
  { id: "wardrobe", label: "Wardrobe" },
  { id: "tents", label: "Tents" },
];
