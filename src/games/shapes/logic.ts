/** Framework-free Shapes rules: validity check, row helpers, win check. No DOM.
 *
 * A set of 4 cards is valid iff every feature is either identical across all
 * four cards (1 distinct value) or different on every card (4 distinct
 * values). Order never matters.
 */

import {
  CELL_COUNT,
  FEATURE_COUNT,
  ROW_COUNT,
  ROW_SIZE,
  cardKey,
  type Card,
  type ShapesBoard,
} from "./types.js";

export function createBoard(cards: Card[], pos: number[]): ShapesBoard {
  return { cards: cards.map((c) => [...c] as Card), pos: [...pos], over: false, won: false };
}

/** The four cards currently sitting in row `r` (0-based). */
export function rowCards(board: Pick<ShapesBoard, "cards" | "pos">, r: number): Card[] {
  const out: Card[] = [];
  for (let c = 0; c < ROW_SIZE; c++) {
    out.push(board.cards[board.pos[r * ROW_SIZE + c]!]!);
  }
  return out;
}

/** True when the four values are all equal or all different. */
export function featureOk(values: readonly number[]): boolean {
  const distinct = new Set(values).size;
  return distinct === 1 || distinct === values.length;
}

/** Validity for exactly 4 cards. Returns false for any other length. */
export function isValidSet(cards: readonly Card[]): boolean {
  if (cards.length !== ROW_SIZE) return false;
  for (let f = 0; f < FEATURE_COUNT; f++) {
    if (!featureOk([cards[0]![f], cards[1]![f], cards[2]![f], cards[3]![f]])) {
      return false;
    }
  }
  return true;
}

/** Convenience alias for four explicit cards. */
export function isValidQuad(a: Card, b: Card, c: Card, d: Card): boolean {
  return isValidSet([a, b, c, d]);
}

/** True when row `r` of the current arrangement forms a valid set. */
export function rowIsValid(board: Pick<ShapesBoard, "cards" | "pos">, r: number): boolean {
  return isValidSet(rowCards(board, r));
}

/** Per-row validity for all 4 rows. */
export function validRows(board: Pick<ShapesBoard, "cards" | "pos">): boolean[] {
  return Array.from({ length: ROW_COUNT }, (_, r) => rowIsValid(board, r));
}

/** True when every card on the board is distinct. */
export function allCardsDistinct(cards: readonly Card[]): boolean {
  return new Set(cards.map(cardKey)).size === cards.length;
}

/** Swap the cards sitting on cells `a` and `b` (cell indices 0..15). */
export function swapCells(board: ShapesBoard, a: number, b: number): boolean {
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  if (a < 0 || a >= CELL_COUNT || b < 0 || b >= CELL_COUNT || a === b) return false;
  if (board.over) return false;
  const tmp = board.pos[a]!;
  board.pos[a] = board.pos[b]!;
  board.pos[b] = tmp;
  return true;
}

/**
 * Full win check: every row must be a valid set. Sets over/won and returns
 * won. (There is no lose state in Shapes; an unsolved board is just not won.)
 */
export function checkWin(board: ShapesBoard): boolean {
  let ok = true;
  for (let r = 0; r < ROW_COUNT && ok; r++) {
    if (!rowIsValid(board, r)) ok = false;
  }
  board.over = ok;
  board.won = ok;
  return ok;
}
