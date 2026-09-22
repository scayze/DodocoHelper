/** Shapes card rendering: compact SVG tiles + board paint. DOM only
 * (excluded from the node test build, like every other game's view).
 *
 * Palette is the colorblind-safe Okabe–Ito subset; shape/count/pattern always
 * redundantly encode the card so color is never the sole channel.
 */

import { ROW_COUNT, ROW_SIZE, type Card, type ShapesBoard } from "./types.js";
import { rowCards } from "./logic.js";
import { isValidSet } from "./logic.js";

/** Fill colors per color index: orange, sky blue, bluish green, vermilion. */
export const SHAPE_COLORS = ["#E69F00", "#56B4E9", "#009E73", "#D55E00"] as const;

const COLOR_NAMES = ["orange", "blue", "green", "red"] as const;
const SHAPE_NAMES = ["circle", "square", "triangle", "star"] as const;
const PATTERN_NAMES = ["solid", "striped", "half", "outline"] as const;

const SVG_NS = "http://www.w3.org/2000/svg";

/** Inject shared stripe/dot pattern defs once (ids `sh-pat-<color>-<kind>`). */
function ensurePatternDefs(): void {
  if (document.getElementById("sh-pat-defs")) return;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.id = "sh-pat-defs";
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.style.position = "absolute";
  const defs = document.createElementNS(SVG_NS, "defs");
  SHAPE_COLORS.forEach((color, ci) => {
    for (const kind of ["stripes", "half"] as const) {
      const pat = document.createElementNS(SVG_NS, "pattern");
      pat.id = `sh-pat-${ci}-${kind}`;
      if (kind === "stripes") {
        pat.setAttribute("width", "6");
        pat.setAttribute("height", "6");
        pat.setAttribute("patternUnits", "userSpaceOnUse");
        const rect = document.createElementNS(SVG_NS, "rect");
        rect.setAttribute("width", "6");
        rect.setAttribute("height", "6");
        rect.setAttribute("fill", "#ffffff");
        const line = document.createElementNS(SVG_NS, "rect");
        line.setAttribute("width", "6");
        line.setAttribute("height", "2.4");
        line.setAttribute("y", "1.8");
        line.setAttribute("fill", color);
        pat.append(rect, line);
      } else {
        // Half fill, left empty / right filled. Bounding-box units so the
        // split tracks each glyph's own middle instead of tiling across it.
        pat.setAttribute("width", "1");
        pat.setAttribute("height", "1");
        pat.setAttribute("patternUnits", "objectBoundingBox");
        pat.setAttribute("patternContentUnits", "objectBoundingBox");
        const bg = document.createElementNS(SVG_NS, "rect");
        bg.setAttribute("width", "1");
        bg.setAttribute("height", "1");
        bg.setAttribute("fill", "#ffffff");
        const right = document.createElementNS(SVG_NS, "rect");
        right.setAttribute("x", "0.5");
        right.setAttribute("width", "0.5");
        right.setAttribute("height", "1");
        right.setAttribute("fill", color);
        pat.append(bg, right);
      }
      defs.appendChild(pat);
    }
  });
  svg.appendChild(defs);
  document.body.appendChild(svg);
}

/** Glyph fill for a pattern: patterns live inside the shapes. */
function fillFor(card: Card): string {
  const [color, , , pattern] = card;
  if (pattern === 0) return SHAPE_COLORS[color]!;
  if (pattern === 1) return `url(#sh-pat-${color}-stripes)`;
  if (pattern === 2) return `url(#sh-pat-${color}-half)`;
  return "#ffffff";
}

/** One glyph centered at (cx, cy) with radius r, as an SVG string. */
function glyphShape(shape: number, cx: number, cy: number, r: number, fill: string, stroke: string): string {
  const strokeAttrs = `stroke="${stroke}" stroke-width="2"`;
  if (shape === 0) {
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" ${strokeAttrs}/>`;
  }
  if (shape === 1) {
    return `<rect x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" rx="2" fill="${fill}" ${strokeAttrs}/>`;
  }
  if (shape === 2) {
    const h = (r * Math.sqrt(3)) / 2;
    return `<polygon points="${cx},${cy - r} ${cx + h},${cy + h / 1.5} ${cx - h},${cy + h / 1.5}" fill="${fill}" ${strokeAttrs} stroke-linejoin="round"/>`;
  }
  // 5-point star.
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 === 0 ? r : r * 0.45;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`);
  }
  return `<polygon points="${pts.join(" ")}" fill="${fill}" ${strokeAttrs} stroke-linejoin="round"/>`;
}

/** Full card face: 1–4 glyphs on a 60x60 viewBox. */
export function renderCardSVG(card: Card): string {
  const [color, shape, count] = card;
  const fill = fillFor(card);
  const stroke = SHAPE_COLORS[color]!;
  const n = count + 1;
  // Layouts: 1 centered; 2 side by side; 3 triangle; 4 in 2x2. Centers are
  // pushed outward and radii trimmed so neighboring glyphs keep a clear gap.
  const spots: Array<[number, number, number]> =
    n === 1
      ? [[30, 30, 16]]
      : n === 2
        ? [
            [16, 30, 11],
            [44, 30, 11],
          ]
        : n === 3
          ? [
              [30, 17, 10],
              [17, 42, 10],
              [43, 42, 10],
            ]
          : [
              [18, 18, 9.5],
              [42, 18, 9.5],
              [18, 42, 9.5],
              [42, 42, 9.5],
            ];
  const glyphs = spots.map(([x, y, r]) => glyphShape(shape, x, y, r, fill, stroke)).join("");
  return `<svg viewBox="0 0 60 60" aria-hidden="true" class="shape-glyphs">${glyphs}</svg>`;
}

/** Spoken description for screen readers. */
export function cardLabel(card: Card, row: number, col: number): string {
  const [color, shape, count, pattern] = card;
  return (
    `Row ${row + 1}, column ${col + 1}: ${count + 1} ` +
    `${PATTERN_NAMES[pattern]} ${COLOR_NAMES[color]} ` +
    `${SHAPE_NAMES[shape]}${count === 0 ? "" : "s"}`
  );
}

/** Build the 16 stable cell buttons (called on deal / restore). */
export function buildShapesGrid(grid: HTMLElement, onTap: (cell: number) => void): void {
  ensurePatternDefs();
  grid.style.gridTemplateColumns = `repeat(${ROW_SIZE}, minmax(0, 1fr))`;
  grid.replaceChildren();
  const frag = document.createDocumentFragment();
  for (let i = 0; i < ROW_SIZE * ROW_COUNT; i++) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "board-cell shape-cell";
    cell.dataset.cell = String(i);
    cell.setAttribute("role", "gridcell");
    cell.addEventListener("click", () => onTap(i));
    frag.appendChild(cell);
  }
  grid.appendChild(frag);
}

/** Repaint faces, selection ring, and valid-row highlights. */
export function paintShapesBoard(
  grid: HTMLElement,
  board: ShapesBoard,
  selected: number | null,
): void {
  const rows: boolean[] = [];
  for (let r = 0; r < ROW_COUNT; r++) {
    rows.push(isValidSet(rowCards(board, r)));
  }
  for (let i = 0; i < ROW_SIZE * ROW_COUNT; i++) {
    const node = grid.children[i] as HTMLElement | undefined;
    if (!node) continue;
    const card = board.cards[board.pos[i]!]!;
    const r = Math.floor(i / ROW_SIZE);
    const c = i % ROW_SIZE;
    node.innerHTML = renderCardSVG(card);
    node.classList.toggle("is-selected", selected === i);
    node.classList.toggle("is-ok", rows[r] === true);
    node.setAttribute("aria-label", cardLabel(card, r, c));
    node.setAttribute("aria-pressed", selected === i ? "true" : "false");
  }
  const done = rows.filter(Boolean).length;
  grid.setAttribute("aria-label", `Shapes board, ${done} of ${ROW_COUNT} rows complete`);
}
