/** Generic rotating quotes shown on the Home landing view. */

export const QUOTES: string[] = [
  "Every puzzle is just patience in disguise.",
  "A sharp mind leaves no crown unplaced.",
  "Small steps solve big grids.",
  "Look twice, click once.",
  "Even Dodoco takes it one tile at a time.",
  "Every mistake is just a hint in disguise.",
  "Slow is smooth, smooth is solved.",
  "The board rewards the curious.",
  "Think like a crown: one per row, one per column.",
  "Today's puzzle is tomorrow's warm-up.",
  "Clear rows, clear mind.",
  "Play daily, improve daily.",
];

export function pickRandomQuote(random: () => number = Math.random): string {
  if (QUOTES.length === 0) return "";
  const index = Math.floor(random() * QUOTES.length) % QUOTES.length;
  return QUOTES[index];
}
