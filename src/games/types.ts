/** Shared contract for every minigame plugged into the shell. */

export type GameId = "crowns" | "minesweeper" | "seasons" | "tents";

/**
 * Each game owns its own DOM subtree (own grid/container, own status and
 * buttons). Games must never reach into another game's elements; the shell
 * in `src/main.ts` only toggles which root section is visible.
 */
export interface GameInstance {
  readonly id: GameId;
  /** Show this game's root section. Called by the shell on tab switch. */
  mount(): void;
  /** Hide this game's root section. State is preserved for return visits. */
  unmount(): void;
}

export interface GameDef {
  readonly id: GameId;
  readonly label: string;
}
