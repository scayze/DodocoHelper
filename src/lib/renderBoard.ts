import type { NormalizedPuzzle } from "../core/types.js";
import type { Hint } from "../core/hints.js";

/** Default region colors sampled from the original game screenshot. */
export const REGION_PALETTE: Array<[number, number, number]> = [
  [116, 198, 196],
  [135, 161, 199],
  [172, 153, 220],
  [236, 189, 208],
  [192, 226, 174],
  [188, 206, 226],
  [208, 139, 168],
  [235, 208, 131],
  [141, 204, 236],
  [254, 190, 144],
  [147, 197, 114],
  [176, 137, 104],
];

const DODOCO_SRC = `${import.meta.env.BASE_URL}dodoco.png`;

function dodocoImg(): string {
  return `<img src="${DODOCO_SRC}" alt="" draggable="false" class="board-dodoco" />`;
}

export function cssFor(puzzle: NormalizedPuzzle, region: number): string {
  if (puzzle.palette && puzzle.palette.length === puzzle.regionCount) {
    return puzzle.palette[region] ?? "#BCCEE2";
  }
  const p = REGION_PALETTE[region % REGION_PALETTE.length];
  return `rgb(${p[0]}, ${p[1]}, ${p[2]})`;
}

/** Build the board grid once per puzzle: one div per cell in region colors. */
export function buildBoardGrid(container: HTMLElement, puzzle: NormalizedPuzzle): void {
  container.style.gridTemplateColumns = `repeat(${puzzle.size}, minmax(0, 1fr))`;
  container.replaceChildren();
  const frag = document.createDocumentFragment();
  for (let r = 0; r < puzzle.size; r++) {
    for (let c = 0; c < puzzle.size; c++) {
      const cell = document.createElement("div");
      cell.className = "board-cell";
      cell.style.backgroundColor = cssFor(puzzle, puzzle.regions[r][c]);
      frag.appendChild(cell);
    }
  }
  container.appendChild(frag);
}

/** Collect every crown position from a solved grid. */
export function solutionCrowns(solution: string[][]): Set<string> {
  const out = new Set<string>();
  for (let r = 0; r < solution.length; r++) {
    for (let c = 0; c < solution[r].length; c++) {
      if (solution[r][c] === "C") out.add(`${r},${c}`);
    }
  }
  return out;
}

/**
 * Paint crowns and X marks onto an existing grid. `crowns` holds "r,c" keys
 * to show; pre-placed givens from `puzzle.initial` always show with a gold rim.
 */
export function paintBoard(
  container: HTMLElement,
  puzzle: NormalizedPuzzle,
  crowns: ReadonlySet<string>,
  hint: Hint | null = null,
): void {
  const n = puzzle.size;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const cell = container.children[r * n + c] as HTMLElement | undefined;
      if (!cell) continue;
      const given = puzzle.initial[r][c] === "C";
      const crowned = given || crowns.has(`${r},${c}`);
      const position = `${r},${c}`;
      cell.classList.toggle("hint-context", Boolean(hint?.cells.includes(position)));
      cell.classList.toggle("hint-decisive", Boolean(hint?.decisiveCells.includes(position)));
      cell.classList.toggle("hint-cross", hint?.kind === "cross" && Boolean(hint.decisiveCells.includes(position)));
      cell.classList.toggle("hint-queen", hint?.kind === "queen" && Boolean(hint.decisiveCells.includes(position)));
      cell.classList.toggle("has-x", !crowned && puzzle.initial[r][c] === ".");
      const want = crowned ? (given ? "g" : "c") : "";
      if (cell.dataset.k !== want) {
        cell.dataset.k = want;
        cell.innerHTML = crowned ? dodocoImg() : "";
      }
    }
  }
}
