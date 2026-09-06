import type { NormalizedPuzzle } from "./types";

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

export const LINE_CSS = "#5f7080";
export const CROWN_CSS = "#2f3b4c";
export const GOLD_CSS = "#c8a028";

export function hexToRgbTuple(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const v = h.length === 3 ? h.split("").map((d) => d + d).join("") : h;
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ];
}

export function cssFor(puzzle: NormalizedPuzzle, region: number): string {
  if (puzzle.palette && puzzle.palette.length === puzzle.regionCount) {
    return puzzle.palette[region] ?? "#BCCEE2";
  }
  const p = REGION_PALETTE[region % REGION_PALETTE.length];
  return `rgb(${p[0]}, ${p[1]}, ${p[2]})`;
}

// Crown silhouette in a 100x100 box (y down), same geometry as the game style.
const CROWN_BODY: Array<[number, number]> = [
  [22, 36], [30, 62], [40, 52], [50, 28], [60, 52], [70, 62],
  [78, 36], [70, 74], [30, 74],
];
const CROWN_BALLS: Array<[number, number, number]> = [
  [22, 30, 6], [50, 22, 6], [78, 30, 6],
];

function traceCrown(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  s: number,
): void {
  const u = s / 100;
  ctx.beginPath();
  CROWN_BODY.forEach(([x, y], i) => {
    const px = cx + (x - 50) * u;
    const py = cy + (y - 50) * u;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
  for (const [x, y, r] of CROWN_BALLS) {
    ctx.moveTo(cx + (x - 50) * u + r * u, cy + (y - 50) * u);
    ctx.arc(cx + (x - 50) * u, cy + (y - 50) * u, r * u, 0, Math.PI * 2);
  }
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export interface BoardDrawOpts {
  cell?: number;
  gap?: number;
  radius?: number;
}

/** Draw region tiles plus crowns onto a canvas element. */
export function drawBoard(
  canvas: HTMLCanvasElement,
  puzzle: NormalizedPuzzle,
  solution: string[][] | null,
  opts: BoardDrawOpts = {},
): void {
  const cell = opts.cell ?? 56;
  const gap = opts.gap ?? 6;
  const radius = opts.radius ?? 9;
  const n = puzzle.size;
  const total = n * cell + (n + 1) * gap;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(total * dpr);
  canvas.height = Math.round(total * dpr);
  canvas.style.aspectRatio = "1 / 1";
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  ctx.fillStyle = LINE_CSS;
  ctx.fillRect(0, 0, total, total);

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = gap + c * (cell + gap);
      const y = gap + r * (cell + gap);
      ctx.fillStyle = cssFor(puzzle, puzzle.regions[r][c]);
      roundRectPath(ctx, x, y, cell, cell, radius);
      ctx.fill();

      const given = puzzle.initial[r][c] === "C";
      const crowned = solution ? solution[r][c] === "C" : given;
      if (crowned) {
        const s = cell * 0.52;
        if (given) {
          ctx.fillStyle = GOLD_CSS;
          ctx.save();
          ctx.translate(0, 0);
          traceCrown(ctx, x + cell / 2, y + cell / 2 - 2, s + 6);
          ctx.fill();
          ctx.restore();
        }
        ctx.fillStyle = CROWN_CSS;
        traceCrown(ctx, x + cell / 2, y + cell / 2 - 2, s);
        ctx.fill();
      } else if (!solution && puzzle.initial[r][c] === ".") {
        // detected X mark from the uploaded photo
        ctx.strokeStyle = "rgba(255,255,255,0.92)";
        ctx.lineWidth = Math.max(2, cell * 0.06);
        ctx.lineCap = "round";
        const m = cell * 0.22;
        const cx = x + cell / 2;
        const cy = y + cell / 2;
        ctx.beginPath();
        ctx.moveTo(cx - m, cy - m);
        ctx.lineTo(cx + m, cy + m);
        ctx.moveTo(cx + m, cy - m);
        ctx.lineTo(cx - m, cy + m);
        ctx.stroke();
      }
    }
  }
}
