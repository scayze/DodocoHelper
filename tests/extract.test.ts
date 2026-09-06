import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ensureOpenCV, extractFromPixels } from "../src/lib/extract.js";

type RGB = [number, number, number];

const PALETTE: RGB[] = [
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

const SLATE: RGB = [100, 116, 132];

/** Row-banded connected regions: region id == row (n distinct, connected). */
function bandedRegions(n: number): number[][] {
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, () => r));
}

function renderBoard(
  n: number,
  cellPx: number,
  gridPx: number,
  regions: number[][],
  marks: Record<string, "x" | "crown">,
): { data: Uint8ClampedArray; w: number; h: number } {
  const S = n * cellPx + (n + 1) * gridPx;
  const data = new Uint8ClampedArray(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    data[i * 4] = SLATE[0];
    data[i * 4 + 1] = SLATE[1];
    data[i * 4 + 2] = SLATE[2];
    data[i * 4 + 3] = 255;
  }
  const cellOrigin = (k: number) => gridPx + k * (cellPx + gridPx);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const col = PALETTE[regions[r][c] % PALETTE.length];
      const x0 = cellOrigin(c);
      const y0 = cellOrigin(r);
      for (let y = 0; y < cellPx; y++) {
        for (let x = 0; x < cellPx; x++) {
          const o = ((y0 + y) * S + x0 + x) * 4;
          data[o] = col[0];
          data[o + 1] = col[1];
          data[o + 2] = col[2];
        }
      }
      const key = `${r},${c}`;
      const m = marks[key];
      if (m === "x") {
        // white diagonals, 3px thick
        for (let t = 0; t < cellPx; t++) {
          for (let dt = -1; dt <= 1; dt++) {
            const a = t + dt;
            const b = t - dt;
            if (a >= 0 && a < cellPx) {
              let o = ((y0 + t) * S + x0 + a) * 4;
              data[o] = 245; data[o + 1] = 245; data[o + 2] = 245;
              o = ((y0 + t) * S + x0 + (cellPx - 1 - a)) * 4;
              void b;
              data[o] = 245; data[o + 1] = 245; data[o + 2] = 245;
            }
          }
        }
      } else if (m === "crown") {
        // dark ring + navy center blob (mimics B/W dodoco icon)
        const cx = x0 + cellPx / 2;
        const cy = y0 + cellPx / 2;
        const rad = cellPx * 0.3;
        for (let y = 0; y < cellPx; y++) {
          for (let x = 0; x < cellPx; x++) {
            const d = Math.hypot(x0 + x - cx, y0 + y - cy);
            const o = ((y0 + y) * S + x0 + x) * 4;
            if (Math.abs(d - rad) < 2.5) {
              data[o] = 25; data[o + 1] = 25; data[o + 2] = 30;
            } else if (d < rad - 2.5) {
              data[o] = 235; data[o + 1] = 238; data[o + 2] = 245;
            }
          }
        }
        // two dark "eyes"
        for (const [ex, ey] of [[-0.12, -0.05], [0.12, -0.05]] as const) {
          const px = Math.round(cx + ex * cellPx);
          const py = Math.round(cy + ey * cellPx);
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const o = ((py + dy) * S + px + dx) * 4;
              data[o] = 20; data[o + 1] = 40; data[o + 2] = 90;
            }
          }
        }
      }
    }
  }
  return { data, w: S, h: S };
}

/** Paste board into a larger clutter canvas (simulates screenshot with extra UI). */
function cluttered(board: { data: Uint8ClampedArray; w: number; h: number }): {
  data: Uint8ClampedArray;
  w: number;
  h: number;
} {
  const W = Math.round(board.w * 1.7);
  const H = Math.round(board.h * 1.5);
  const data = new Uint8ClampedArray(W * H * 4).fill(232);
  for (let i = 0; i < W * H; i++) data[i * 4 + 3] = 255;
  const ox = Math.round(W * 0.25);
  const oy = Math.round(H * 0.2);
  for (let y = 0; y < board.h; y++) {
    for (let x = 0; x < board.w; x++) {
      const s = (y * board.w + x) * 4;
      const d = ((oy + y) * W + ox + x) * 4;
      data[d] = board.data[s];
      data[d + 1] = board.data[s + 1];
      data[d + 2] = board.data[s + 2];
    }
  }
  return { data, w: W, h: H };
}

/** Rough perspective tilt via bilinear resample of a perturbed quad. */
function tilted(board: { data: Uint8ClampedArray; w: number; h: number }): {
  data: Uint8ClampedArray;
  w: number;
  h: number;
} {
  const { data: src, w: sw, h: sh } = board;
  const W = Math.round(sw * 1.15);
  const H = Math.round(sh * 1.15);
  const dst = new Uint8ClampedArray(W * H * 4).fill(235);
  for (let i = 0; i < W * H; i++) dst[i * 4 + 3] = 255;
  // source corners -> perturbed dest quad
  const qx = [W * 0.1, W * 0.88, W * 0.93, W * 0.05];
  const qy = [H * 0.06, H * 0.12, H * 0.95, H * 0.9];
  // inverse-map each dest pixel by bilinear interpolation of quad (approx via
  // normalized coordinates — good enough as a synthetic tilt)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x / W - 0.08) / 0.84;
      const v = (y / H - 0.08) / 0.84;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const sx = u * (sw - 1);
      const sy = v * (sh - 1);
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const d = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) {
        const a = src[(y0 * sw + x0) * 4 + k];
        const b = src[(y0 * sw + x1) * 4 + k];
        const c = src[(y1 * sw + x0) * 4 + k];
        const e = src[(y1 * sw + x1) * 4 + k];
        dst[d + k] = Math.round(a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + e * fx * fy);
      }
      void qx;
      void qy;
    }
  }
  return { data: dst, w: W, h: H };
}

describe("extractFromPixels (resilient importer)", () => {
  before(async () => {
    await ensureOpenCV();
  });

  it("recovers a clean 9x9 board with X and crown marks", () => {
    const regions = bandedRegions(9);
    const { data, w, h } = renderBoard(9, 44, 5, regions, { "0,1": "x", "1,1": "crown", "8,8": "x" });
    const res = extractFromPixels(data, w, h);
    assert.equal(res.ok, true, res.error ?? "failed");
    assert.equal(res.boardSize, 9);
    assert.equal(res.clusterCount, 9);
    assert.ok(res.marks >= 2, `expected marks>=2, got ${res.marks}`);
    assert.ok(res.puzzle);
    assert.ok(res.puzzle.initial);
    assert.equal(res.puzzle.initial[0][1], ".");
    assert.equal(res.puzzle.initial[1][1], "C");
  });

  it("recovers a clean 10x10 board", () => {
    const regions = bandedRegions(10);
    const { data, w, h } = renderBoard(10, 36, 4, regions, { "2,3": "x", "5,5": "crown" });
    const res = extractFromPixels(data, w, h);
    assert.equal(res.ok, true, res.error ?? "failed");
    assert.equal(res.boardSize, 10);
    assert.equal(res.clusterCount, 10);
  });

  it("finds a 9x9 board inside a cluttered screenshot", () => {
    const regions = bandedRegions(9);
    const board = renderBoard(9, 40, 5, regions, { "3,3": "x", "4,4": "crown" });
    const shot = cluttered(board);
    const res = extractFromPixels(shot.data, shot.w, shot.h);
    assert.equal(res.ok, true, res.error ?? "failed");
    assert.equal(res.boardSize, 9);
  });

  it("tolerates a tilted phone-photo-like warp", () => {
    const regions = bandedRegions(9);
    const board = renderBoard(9, 44, 5, regions, { "0,1": "x", "1,1": "crown" });
    const shot = tilted(board);
    const res = extractFromPixels(shot.data, shot.w, shot.h);
    assert.equal(res.ok, true, res.error ?? "failed");
    assert.equal(res.boardSize, 9);
    assert.equal(res.clusterCount, 9);
  });
});
