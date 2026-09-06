import { deflateSync } from "node:zlib";
import type { NormalizedPuzzle } from "./types.js";

export type RGB = [number, number, number];

/** Palette sampled from the original game screenshot (region id -> color). */
export const REGION_PALETTE: RGB[] = [
  [116, 198, 196], // teal
  [135, 161, 199], // slate blue
  [172, 153, 220], // purple
  [236, 189, 208], // pink
  [192, 226, 174], // green
  [188, 206, 226], // light gray-blue
  [208, 139, 168], // rose
  [235, 208, 131], // yellow
  [141, 204, 236], // sky blue
  [254, 190, 144], // orange
  [147, 197, 114], // lime green
  [176, 137, 104], // brown
];

export const LINE_COLOR: RGB = [95, 112, 128];
export const CROWN_COLOR: RGB = [47, 59, 76];
export const GOLD_COLOR: RGB = [200, 160, 40];

export interface RenderOptions {
  cell?: number;
  gap?: number;
  radius?: number;
}

export function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  const v = h.length === 3 ? h.split("").map((d) => d + d).join("") : h;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

/** Active palette: per-puzzle colors when provided, else the default set. */
export function paletteFor(puzzle: NormalizedPuzzle): RGB[] {
  if (puzzle.palette && puzzle.palette.length === puzzle.regionCount) {
    return puzzle.palette.map(hexToRgb);
  }
  return REGION_PALETTE;
}

export interface Pixels {
  width: number;
  height: number;
  data: Buffer; // width*height*3 RGB bytes
}

function setPixel(px: Pixels, x: number, y: number, c: RGB): void {
  if (x < 0 || y < 0 || x >= px.width || y >= px.height) return;
  const o = (y * px.width + x) * 3;
  px.data[o] = c[0];
  px.data[o + 1] = c[1];
  px.data[o + 2] = c[2];
}

function fillRect(px: Pixels, x0: number, y0: number, x1: number, y1: number, c: RGB): void {
  for (let y = Math.max(0, y0); y < Math.min(px.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(px.width, x1); x++) {
      setPixel(px, x, y, c);
    }
  }
}

function fillRoundedRect(
  px: Pixels, x0: number, y0: number, w: number, h: number, r: number, c: RGB,
): void {
  fillRect(px, x0 + r, y0, x0 + w - r, y0 + h, c);
  fillRect(px, x0, y0 + r, x0 + w, y0 + h - r, c);
  const corners: Array<[number, number]> = [
    [x0 + r, y0 + r],
    [x0 + w - r, y0 + r],
    [x0 + r, y0 + h - r],
    [x0 + w - r, y0 + h - r],
  ];
  for (const [cx, cy] of corners) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r * r) setPixel(px, x, y, c);
      }
    }
  }
}

function fillCircle(px: Pixels, cx: number, cy: number, r: number, c: RGB): void {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) setPixel(px, x, y, c);
    }
  }
}

function fillPolygon(px: Pixels, pts: Array<[number, number]>, c: RGB): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of pts) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  for (let y = Math.ceil(minY); y <= Math.floor(maxY); y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) {
        xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (let x = Math.ceil(xs[i]); x <= Math.floor(xs[i + 1]); x++) {
        setPixel(px, x, y, c);
      }
    }
  }
}

// Crown silhouette in a 100x100 box (y down), same geometry as the game style.
const CROWN_BODY: Array<[number, number]> = [
  [22, 36], [30, 62], [40, 52], [50, 28], [60, 52], [70, 62],
  [78, 36], [70, 74], [30, 74],
];
const CROWN_BALLS: Array<[number, number, number]> = [
  [22, 30, 6], [50, 22, 6], [78, 30, 6],
];

function drawCrown(px: Pixels, cx: number, cy: number, s: number, goldRim: boolean): void {
  const place = (scale: number): { body: Array<[number, number]>; balls: Array<[number, number, number]> } => ({
    body: CROWN_BODY.map(([x, y]) => [cx + (x - 50) * scale, cy + (y - 50) * scale] as [number, number]),
    balls: CROWN_BALLS.map(([x, y, r]) => [cx + (x - 50) * scale, cy + (y - 50) * scale, r * scale] as [number, number, number]),
  });
  const u = s / 100;
  if (goldRim) {
    const rim = place((s + 7) / 100);
    fillPolygon(px, rim.body, GOLD_COLOR);
    for (const [x, y, r] of rim.balls) fillCircle(px, x, y, r, GOLD_COLOR);
  }
  const main = place(u);
  fillPolygon(px, main.body, CROWN_COLOR);
  for (const [x, y, r] of main.balls) fillCircle(px, x, y, r, CROWN_COLOR);
}

/** Rasterize the board: region tiles + crowns where solution has "C". */
export function renderPixels(
  puzzle: NormalizedPuzzle,
  solution: string[][] | null,
  opts: RenderOptions = {},
): Pixels {
  const cell = opts.cell ?? 64;
  const gap = opts.gap ?? 6;
  const radius = opts.radius ?? 10;
  const n = puzzle.size;
  const W = n * cell + (n + 1) * gap;
  const px: Pixels = { width: W, height: W, data: Buffer.alloc(W * W * 3) };
  fillRect(px, 0, 0, W, W, LINE_COLOR);
  const palette = paletteFor(puzzle);

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = gap + c * (cell + gap);
      const y = gap + r * (cell + gap);
      const gid = puzzle.regions[r][c];
      fillRoundedRect(px, x, y, cell, cell, radius, palette[gid % palette.length]);

      const given = puzzle.initial[r][c] === "C";
      const isCrown = solution ? solution[r][c] === "C" : given;
      if (isCrown) {
        drawCrown(px, x + cell / 2, y + cell / 2 - 2, cell * 0.52, given);
      }
    }
  }
  return px;
}

// --- Minimal PNG encoder (raw RGB -> zlib -> IHDR/IDAT/IEND) ---

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encode raw pixels as a PNG buffer (8-bit RGB, non-interlaced). */
export function encodePng(px: Pixels): Buffer {
  const raw = Buffer.alloc(px.height * (1 + px.width * 3));
  for (let y = 0; y < px.height; y++) {
    const src = y * px.width * 3;
    raw[y * (1 + px.width * 3)] = 0; // filter: none
    px.data.copy(raw, y * (1 + px.width * 3) + 1, src, src + px.width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px.width, 0);
  ihdr.writeUInt32BE(px.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Convenience: rasterize + encode in one call. */
export function renderBoard(
  puzzle: NormalizedPuzzle,
  solution: string[][] | null,
  opts: RenderOptions = {},
): Buffer {
  return encodePng(renderPixels(puzzle, solution, opts));
}
