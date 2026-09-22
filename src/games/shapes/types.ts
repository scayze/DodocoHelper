/** Shapes core model: a card carries one value (0..3) per feature. No DOM. */

export const FEATURE_COUNT = 4;
export const VALUES_PER_FEATURE = 4;
/** Board is always 4 rows of 4. */
export const ROW_SIZE = 4;
export const ROW_COUNT = 4;
export const CELL_COUNT = ROW_SIZE * ROW_COUNT;

export const FEATURE_NAMES = ["color", "shape", "count", "pattern"] as const;

/** A card: [color, shape, count, pattern], each 0..3. */
export type Card = [number, number, number, number];

/** Board state. `cards` holds the 16 distinct deal cards; `pos` maps each
 *  grid cell (row-major 0..15) to an index into `cards`. Swaps exchange `pos`
 *  entries; `cards` never moves. */
export interface ShapesBoard {
  cards: Card[];
  pos: number[];
  over: boolean;
  won: boolean;
}

/** Canonical key for dedupe checks (`"c,s,n,p"`). */
export function cardKey(card: Card): string {
  return `${card[0]},${card[1]},${card[2]},${card[3]}`;
}

export function isValidCardValue(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) < VALUES_PER_FEATURE;
}

export function isCard(value: unknown): value is Card {
  return (
    Array.isArray(value) &&
    value.length === FEATURE_COUNT &&
    value.every(isValidCardValue)
  );
}
