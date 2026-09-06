import type { PuzzleInput } from "./types";

export type RGB = [number, number, number];

export interface ExtractResult {
  ok: boolean;
  puzzle: PuzzleInput | null;
  boardSize: number;
  lineCounts: { v: number; h: number };
  clusterCount: number;
  marks: number;
  /** Downscaled preview data URL for display. */
  previewUrl: string | null;
  error: string | null;
}

function isLinePixel(r: number, g: number, b: number): boolean {
  const mx = Math.max(r, Math.max(g, b));
  const mn = Math.min(r, Math.min(g, b));
  return mx - mn < 40 && mx < 170;
}

/** Scan for grid lines. horizontal=true scans rows (returns y positions). */
function findLines(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  horizontal: boolean,
): number[] {
  const len = horizontal ? h : w;
  const span = horizontal ? w : h;
  const hits: number[] = [];
  for (let i = 0; i < len; i++) {
    let cnt = 0;
    let tot = 0;
    for (let j = 0; j < span; j += 3) {
      const x = horizontal ? j : i;
      const y = horizontal ? i : j;
      const o = (y * w + x) * 4;
      tot++;
      if (isLinePixel(data[o], data[o + 1], data[o + 2])) cnt++;
    }
    if (cnt > tot * 0.7) hits.push(i);
  }
  if (hits.length === 0) return [];
  const lines: number[] = [];
  let start = hits[0];
  let prev = hits[0];
  for (let k = 1; k < hits.length; k++) {
    if (hits[k] > prev + 2) {
      lines.push(Math.round((start + prev) / 2));
      start = hits[k];
    }
    prev = hits[k];
  }
  lines.push(Math.round((start + prev) / 2));
  return lines;
}

function avgPatch(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  cx: number,
  cy: number,
): RGB {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = Math.min(w - 1, Math.max(0, cx + dx));
      const y = Math.min(h - 1, Math.max(0, cy + dy));
      const o = (y * w + x) * 4;
      r += data[o];
      g += data[o + 1];
      b += data[o + 2];
      n++;
    }
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

function dist(a: RGB, b: RGB): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function toHex([r, g, b]: RGB): string {
  const h = (v: number) => v.toString(16).padStart(2, "0").toUpperCase();
  return `#${h(r)}${h(g)}${h(b)}`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not decode that image file"));
    img.src = src;
  });
}

/**
 * Simple board extraction, mirroring tools/extract-board.ps1:
 * line scan, off-center background sampling, center-whiteness X test,
 * greedy color clustering with distance threshold 30.
 */
export async function extractBoardFromFile(file: File): Promise<ExtractResult> {
  const fail = (error: string): ExtractResult => ({
    ok: false,
    puzzle: null,
    boardSize: 0,
    lineCounts: { v: 0, h: 0 },
    clusterCount: 0,
    marks: 0,
    previewUrl: null,
    error,
  });

  let objectUrl = "";
  try {
    objectUrl = URL.createObjectURL(file);
    const img = await loadImage(objectUrl);

    // Cap working size for speed, keep aspect.
    const maxSide = 900;
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(2, Math.round(img.naturalWidth * scale));
    const h = Math.max(2, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return fail("canvas 2d is not available in this browser");
    ctx.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(objectUrl);
    objectUrl = "";

    const data = ctx.getImageData(0, 0, w, h).data;
    const vlines = findLines(data, w, h, false);
    const hlines = findLines(data, w, h, true);
    if (vlines.length < 2 || vlines.length !== hlines.length) {
      return fail(
        `no clean grid found (found ${vlines.length} vertical and ${hlines.length} horizontal lines). Use a cropped shot of the board with clear grid lines.`,
      );
    }
    const n = vlines.length - 1;
    if (n < 2 || n > 25) return fail(`detected board size ${n}x${n} is outside the 2..25 range`);

    interface Cell {
      r: number;
      c: number;
      rgb: RGB;
      x: boolean;
    }
    const cells: Cell[] = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const x0 = vlines[c];
        const x1 = vlines[c + 1];
        const y0 = hlines[r];
        const y1 = hlines[r + 1];
        const cw = x1 - x0;
        const ch = y1 - y0;
        const pts: Array<[number, number]> = [
          [Math.round(x0 + cw * 0.28), Math.round(y0 + ch * 0.28)],
          [Math.round(x0 + cw * 0.72), Math.round(y0 + ch * 0.28)],
          [Math.round(x0 + cw * 0.28), Math.round(y0 + ch * 0.72)],
          [Math.round(x0 + cw * 0.72), Math.round(y0 + ch * 0.72)],
        ];
        let br = 0;
        let bg = 0;
        let bb = 0;
        for (const [px, py] of pts) {
          const a = avgPatch(data, w, h, px, py);
          br += a[0];
          bg += a[1];
          bb += a[2];
        }
        br = Math.round(br / 4);
        bg = Math.round(bg / 4);
        bb = Math.round(bb / 4);
        const ctr = avgPatch(data, w, h, Math.round(x0 + cw / 2), Math.round(y0 + ch / 2));
        const wCtr = Math.min(ctr[0], Math.min(ctr[1], ctr[2]));
        const wBg = Math.min(br, Math.min(bg, bb));
        cells.push({ r, c, rgb: [br, bg, bb], x: wCtr - wBg > 50 });
      }
    }

    // Greedy clustering, threshold 30, same as the PS1 tool.
    const clusters: Array<{ rgb: RGB; members: Cell[] }> = [];
    for (const cell of cells) {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < clusters.length; i++) {
        const d = dist(cell.rgb, clusters[i].rgb);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best >= 0 && bestD < 30) clusters[best].members.push(cell);
      else clusters.push({ rgb: cell.rgb, members: [cell] });
    }

    if (clusters.length !== n) {
      return {
        ok: false,
        puzzle: null,
        boardSize: n,
        lineCounts: { v: vlines.length, h: hlines.length },
        clusterCount: clusters.length,
        marks: cells.filter((c) => c.x).length,
        previewUrl: canvas.toDataURL("image/png"),
        error: `found ${clusters.length} region colors but a ${n}x${n} board needs exactly ${n}. Try a sharper crop with even lighting.`,
      };
    }

    const regionOf = (cell: Cell): number => {
      for (let i = 0; i < clusters.length; i++) {
        if (clusters[i].members.includes(cell)) return i;
      }
      return 0;
    };
    const regions: number[][] = [];
    const initial: string[][] = [];
    for (let r = 0; r < n; r++) {
      const rr: number[] = [];
      const ir: string[] = [];
      for (let c = 0; c < n; c++) {
        const cell = cells[r * n + c];
        rr.push(regionOf(cell));
        ir.push(cell.x ? "." : "?");
      }
      regions.push(rr);
      initial.push(ir);
    }
    const palette = clusters.map((k) => toHex(k.rgb));
    return {
      ok: true,
      puzzle: {
        size: n,
        crownsPerRow: 2,
        crownsPerColumn: 2,
        crownsPerRegion: 2,
        regions,
        initial,
        palette,
      },
      boardSize: n,
      lineCounts: { v: vlines.length, h: hlines.length },
      clusterCount: clusters.length,
      marks: cells.filter((c) => c.x).length,
      previewUrl: canvas.toDataURL("image/png"),
      error: null,
    };
  } catch (e) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    return fail(e instanceof Error ? e.message : "could not read that image");
  }
}
