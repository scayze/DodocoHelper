import type { PuzzleInput } from "../core/types.js";

export type RGB = [number, number, number];
export type Lab = [number, number, number];
export type Pt = { x: number; y: number };

export interface ExtractResult {
  ok: boolean;
  puzzle: PuzzleInput | null;
  boardSize: number;
  lineCounts: { v: number; h: number };
  clusterCount: number;
  marks: number;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

function lum(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Slate grid/frame gray-blue. Loose tier tolerates phone white-balance shift. */
function isSlate(r: number, g: number, b: number, loose: boolean): boolean {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const sat = mx - mn;
  const l = lum(r, g, b);
  if (loose) return sat < 62 && l > 38 && l < 188 && b >= r - 16;
  return sat < 42 && l > 50 && l < 168 && b >= r - 8 && g >= r - 8;
}

function isWhitePx(r: number, g: number, b: number): boolean {
  const mn = Math.min(r, g, b);
  const mx = Math.max(r, g, b);
  return mn > 165 && mx - mn < 60;
}

/** Dark ink of dodoco icons (black outline / navy fill), not slate grid. */
function isDarkInk(r: number, g: number, b: number): boolean {
  return lum(r, g, b) < 115 && !isSlate(r, g, b, true);
}

function isBlueDark(r: number, g: number, b: number): boolean {
  return b > 60 && b > r + 8 && lum(r, g, b) < 150;
}

export function rgbToLab(r: number, g: number, b: number): Lab {
  // sRGB -> XYZ -> Lab (D65)
  let R = r / 255;
  let G = g / 255;
  let B = b / 255;
  R = R > 0.04045 ? Math.pow((R + 0.055) / 1.055, 2.4) : R / 12.92;
  G = G > 0.04045 ? Math.pow((G + 0.055) / 1.055, 2.4) : G / 12.92;
  B = B > 0.04045 ? Math.pow((B + 0.055) / 1.055, 2.4) : B / 12.92;
  let X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  let Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  X = f(X);
  const YY = f(Y);
  Z = f(Z);
  return [116 * YY - 16, 500 * (X - YY), 200 * (YY - Z)];
}

function labDist(a: Lab, b: Lab): number {
  const dL = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

function toHex([r, g, b]: RGB): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0").toUpperCase();
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

// ---------------------------------------------------------------------------
// Geometry: hull, quad approx, homography, warp
// ---------------------------------------------------------------------------

function convexHull(pts: Pt[]): Pt[] {
  if (pts.length < 4) return pts.slice();
  const s = pts.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of s) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function triArea(a: Pt, b: Pt, c: Pt): number {
  return Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
}

/** Reduce polygon to 4 vertices by repeatedly dropping min-area-loss ear. */
function approxQuad(hull: Pt[]): Pt[] | null {
  let poly = hull.slice();
  if (poly.length < 4) return null;
  if (poly.length === 4) return poly;
  // cap input size for O(n^2) loop
  if (poly.length > 120) {
    const step = poly.length / 120;
    const sub: Pt[] = [];
    for (let i = 0; i < poly.length; i += step) sub.push(poly[Math.floor(i)]);
    poly = sub;
  }
  while (poly.length > 4) {
    let best = 0;
    let bestLoss = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[(i - 1 + poly.length) % poly.length];
      const b = poly[i];
      const c = poly[(i + 1) % poly.length];
      const loss = triArea(a, b, c);
      if (loss < bestLoss) {
        bestLoss = loss;
        best = i;
      }
    }
    poly.splice(best, 1);
  }
  return poly;
}

function orderQuad(q: Pt[]): Pt[] {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  return q.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
}

/** Map TL->TR->BR->BL consistently starting at top-left. */
function orientQuad(q: Pt[]): Pt[] {
  const o = orderQuad(q);
  // orderQuad gives CCW starting at angle -pi; rotate so TL (min x+y) first
  let tl = 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const s = o[i].x + o[i].y;
    if (s < best) {
      best = s;
      tl = i;
    }
  }
  const ccw = [o[tl], o[(tl + 1) % 4], o[(tl + 2) % 4], o[(tl + 3) % 4]];
  // ensure clockwise TL,TR,BR,BL: in image coords (y down), CCW from TL goes to TR? fix by checking
  // cross of (TR-TL)x(BR-TR) should be >0 for clockwise in y-down coords.
  const cross =
    (ccw[1].x - ccw[0].x) * (ccw[2].y - ccw[1].y) - (ccw[1].y - ccw[0].y) * (ccw[2].x - ccw[1].x);
  if (cross < 0) return [ccw[0], ccw[3], ccw[2], ccw[1]];
  return ccw;
}

function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-9) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    for (let k = c; k <= n; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row) => row[n]);
}

/** Homography mapping src->dst (3x3, h[8]=1). */
function getHomography(src: Pt[], dst: Pt[]): number[] | null {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solveLinear(A, b);
  if (!h) return null;
  return [...h, 1];
}

export function warpToSquare(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  quad: Pt[],
  size: number,
): Uint8ClampedArray | null {
  const dst: Pt[] = [
    { x: 0, y: 0 },
    { x: size - 1, y: 0 },
    { x: size - 1, y: size - 1 },
    { x: 0, y: size - 1 },
  ];
  // need dst->src sampling transform
  const H = getHomography(dst, quad);
  if (!H) return null;
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const w = H[6] * x + H[7] * y + H[8];
      const sx = (H[0] * x + H[1] * y + H[2]) / w;
      const sy = (H[3] * x + H[4] * y + H[5]) / w;
      const o = (y * size + x) * 4;
      if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) {
        out[o + 3] = 255;
        continue;
      }
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      for (let k = 0; k < 4; k++) {
        const a = src[(y0 * sw + x0) * 4 + k];
        const bb = src[(y0 * sw + x1) * 4 + k];
        const c = src[(y1 * sw + x0) * 4 + k];
        const d = src[(y1 * sw + x1) * 4 + k];
        out[o + k] = Math.round(a * (1 - fx) * (1 - fy) + bb * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Board localization: largest slate connected component
// ---------------------------------------------------------------------------

interface BoardHypo {
  quad: Pt[];
  area: number;
  strict: boolean;
}

function slateMaskOf(data: Uint8ClampedArray, w: number, h: number, loose: boolean): Uint8Array {
  // 3x3 box blur first to kill screen moire/subpixels, then threshold
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // cheap 3x3 average of luma/chroma via direct neighbors at stride 1
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const o = (yy * w + xx) * 4;
          r += data[o];
          g += data[o + 1];
          b += data[o + 2];
          n++;
        }
      }
      r /= n;
      g /= n;
      b /= n;
      if (isSlate(r, g, b, loose)) mask[y * w + x] = 1;
    }
  }
  return mask;
}

function largestComponent(mask: Uint8Array, w: number, h: number): {
  count: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  labels: Int32Array | null;
  id: number;
} {
  const labels = new Int32Array(w * h).fill(-1);
  let bestCount = 0;
  let best = { minX: 0, maxX: 0, minY: 0, maxY: 0, id: -1 };
  let cur = 0;
  const stack: number[] = [];
  // stride 2 for speed; components stay connected through grid lines
  const st = 2;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const idx = y * w + x;
      if (!mask[idx] || labels[idx] !== -1) continue;
      if ((x + y) % st !== 0 && (x % st !== 0 || y % st !== 0)) {
        // still label every pixel but seed BFS on stride grid to cut cost;
        // flood fills full connectivity regardless.
      }
      let count = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      stack.length = 0;
      stack.push(idx);
      labels[idx] = cur;
      while (stack.length) {
        const p = stack.pop()!;
        count++;
        const px = p % w;
        const py = (p / w) | 0;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        // 4-neighbors
        if (px > 0) {
          const q = p - 1;
          if (mask[q] && labels[q] === -1) {
            labels[q] = cur;
            stack.push(q);
          }
        }
        if (px + 1 < w) {
          const q = p + 1;
          if (mask[q] && labels[q] === -1) {
            labels[q] = cur;
            stack.push(q);
          }
        }
        if (py > 0) {
          const q = p - w;
          if (mask[q] && labels[q] === -1) {
            labels[q] = cur;
            stack.push(q);
          }
        }
        if (py + 1 < h) {
          const q = p + w;
          if (mask[q] && labels[q] === -1) {
            labels[q] = cur;
            stack.push(q);
          }
        }
      }
      if (count > bestCount) {
        bestCount = count;
        best = { minX, maxX, minY, maxY, id: cur };
      }
      cur++;
      if (cur > 4000) break; // cluttered UI safety cap
    }
  }
  return {
    count: bestCount,
    minX: best.minX,
    maxX: best.maxX,
    minY: best.minY,
    maxY: best.maxY,
    labels: best.id >= 0 ? labels : null,
    id: best.id,
  };
}

function quadFromComponent(
  labels: Int32Array,
  id: number,
  w: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): Pt[] | null {
  // boundary points of the component (slate pixel adjacent to non-slate),
  // stride-sampled evenly over the whole bbox so large boards aren't truncated
  const pts: Pt[] = [];
  const bwArea = Math.max(1, maxX - minX + 1);
  const bhArea = Math.max(1, maxY - minY + 1);
  const step = Math.max(1, Math.floor(Math.sqrt((bwArea * bhArea) / 2500)));
  for (let y = minY; y <= maxY; y += step) {
    for (let x = minX; x <= maxX; x += step) {
      const idx = y * w + x;
      if (labels[idx] !== id) continue;
      const edge =
        x === minX ||
        x === maxX ||
        y === minY ||
        y === maxY ||
        labels[idx - 1] !== id ||
        (x + 1 <= maxX && labels[idx + 1] !== id) ||
        labels[idx - w] !== id ||
        labels[idx + w] !== id;
      if (edge) pts.push({ x, y });
      if (pts.length > 4000) break;
    }
    if (pts.length > 4000) break;
  }
  if (pts.length < 16) return null;
  const hull = convexHull(pts);
  if (hull.length < 4) return null;
  const quad = approxQuad(hull);
  if (!quad) return null;
  return orientQuad(quad);
}

export /** Push quad vertices outward from centroid so outer grid lines stay inside the warp. */
function expandQuad(q: Pt[], w: number, h: number, frac: number): Pt[] {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  return q.map((p) => ({
    x: Math.min(w - 1, Math.max(0, cx + (p.x - cx) * (1 + frac))),
    y: Math.min(h - 1, Math.max(0, cy + (p.y - cy) * (1 + frac))),
  }));
}

function polyArea(q: Pt[]): number {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i];
    const r = q[(i + 1) % q.length];
    a += p.x * r.y - r.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** True when all four turns go the same way with sane interior angles. */
function isConvexQuad(q: Pt[]): boolean {
  if (q.length !== 4) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const ab = Math.hypot(b.x - a.x, b.y - a.y);
    const bc = Math.hypot(c.x - b.x, c.y - b.y);
    if (ab < 1e-6 || bc < 1e-6) return false;
    // sin of turn angle must be comfortably away from 0 (no spikes/slivers)
    const sin = cross / (ab * bc);
    if (Math.abs(sin) < 0.2) return false;
    const s = Math.sign(sin);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export function boardHypos(data: Uint8ClampedArray, w: number, h: number): BoardHypo[] {
  const out: BoardHypo[] = [];
  const full: Pt[] = [
    { x: 0, y: 0 },
    { x: w - 1, y: 0 },
    { x: w - 1, y: h - 1 },
    { x: 0, y: h - 1 },
  ];
  for (const loose of [false, true]) {
    const mask = slateMaskOf(data, w, h, loose);
    let slateCount = 0;
    for (let i = 0; i < mask.length; i += 4) slateCount += mask[i];
    slateCount *= 4;
    const comp = largestComponent(mask, w, h);
    const imgArea = w * h;
    if (comp.labels && comp.count > imgArea * 0.015) {
      const bw = comp.maxX - comp.minX + 1;
      const bh = comp.maxY - comp.minY + 1;
      const aspect = bw / Math.max(1, bh);
      if (aspect > 0.6 && aspect < 1.7 && bw > w * 0.12 && bh > h * 0.12) {
        const q = quadFromComponent(comp.labels, comp.id, w, comp.minX, comp.maxX, comp.minY, comp.maxY);
        if (q) {
          // reject degenerate / tiny / non-convex quads (hull approx can emit
          // bowties on noisy masks; expand slightly: masks erode lines by ~1px)
          const xq = orientQuad(expandQuad(q, w, h, 0.015));
          const area = polyArea(xq);
          if (area > imgArea * 0.01 && isConvexQuad(xq)) out.push({ quad: xq, area, strict: !loose });
        }
        // bbox fallback, expanded outward (handles failed hull approx on heavy tilt)
        const m = Math.min(bw, bh) * 0.02;
        const bq = orientQuad(
          expandQuad(
            [
              { x: comp.minX, y: comp.minY },
              { x: comp.maxX, y: comp.minY },
              { x: comp.maxX, y: comp.maxY },
              { x: comp.minX, y: comp.maxY },
            ],
            w,
            h,
            m / Math.max(1, Math.min(bw, bh)),
          ),
        );
        out.push({
          quad: bq,
          area: bw * bh,
          strict: !loose,
        });
      }
    }
    if (out.length >= 2) break;
  }
  out.push({ quad: full, area: w * h, strict: true });
  // dedupe near-identical quads
  const dedup: BoardHypo[] = [];
  for (const q of out) {
    if (dedup.every((d) => Math.abs(d.area - q.area) / Math.max(1, q.area) > 0.02)) dedup.push(q);
    if (dedup.length >= 4) break;
  }
  return dedup;
}

// ---------------------------------------------------------------------------
// Grid detection on rectified square
// ---------------------------------------------------------------------------

interface GridHit {
  lines: number[];
  n: number;
  score: number;
}

function smooth1D(p: number[], r: number): number[] {
  const out = new Array(p.length).fill(0);
  for (let i = 0; i < p.length; i++) {
    let s = 0;
    let c = 0;
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      if (j < 0 || j >= p.length) continue;
      s += p[j];
      c++;
    }
    out[i] = s / Math.max(1, c);
  }
  return out;
}

export function profilesOf(img: Uint8ClampedArray, s: number, loose: boolean): { cols: number[]; rows: number[] } {
  const cols = new Array(s).fill(0);
  const rows = new Array(s).fill(0);
  const y0 = Math.floor(s * 0.12);
  const y1 = Math.ceil(s * 0.88);
  const x0 = Math.floor(s * 0.12);
  const x1 = Math.ceil(s * 0.88);
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < s; x += 2) {
      const o = (y * s + x) * 4;
      if (isSlate(img[o], img[o + 1], img[o + 2], loose)) cols[x]++;
    }
  }
  for (let x = x0; x < x1; x++) {
    for (let y = 0; y < s; y += 2) {
      const o = (y * s + x) * 4;
      if (isSlate(img[o], img[o + 1], img[o + 2], loose)) rows[y]++;
    }
  }
  const normC = (y1 - y0) / 2;
  const normR = (x1 - x0) / 2;
  return {
    cols: cols.map((v) => v / Math.max(1, normC)),
    rows: rows.map((v) => v / Math.max(1, normR)),
  };
}

function peakGroups(p: number[], minH: number): number[] {
  const centers: number[] = [];
  let i = 0;
  while (i < p.length) {
    if (p[i] >= minH) {
      let j = i;
      while (j < p.length && p[j] >= minH * 0.55) j++;
      // weighted centroid
      let sw = 0;
      let sx = 0;
      for (let k = i; k < j; k++) {
        sw += p[k];
        sx += p[k] * k;
      }
      if (sw > 0) centers.push(sx / sw);
      i = j;
    } else i++;
  }
  return centers;
}

function fitGrid(peaks: number[], span: number): GridHit | null {
  if (peaks.length < 6) return null;
  const sorted = peaks.slice().sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (last - first < span * 0.4) return null;
  // Estimate pitch from median inter-peak gap so 9x9 vs 10x10 isn't a coin toss.
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
  const med = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] || (last - first) / 9;
  const estN = Math.max(4, Math.min(14, Math.round((last - first) / Math.max(4, med))));
  // 9x9 and 10x10 first (core requirement), estimator takes precedence
  const rawOrder = [estN, estN + 1, estN - 1, 10, 9, 11, 8, 12, 7, 6, 13];
  const order = [...new Set(rawOrder)].filter((x) => x >= 4 && x <= 14);
  let best: GridHit | null = null;
  for (const n of order) {
    const need = n + 1;
    if (sorted.length < need - 2 || sorted.length > need + 8) continue;
    const step = (last - first) / n;
    if (step < 8) continue;
    const lines: number[] = [];
    let err = 0;
    let matched = 0;
    for (let k = 0; k <= n; k++) {
      const exp = first + k * step;
      let bi = -1;
      let bd = Infinity;
      for (let i = 0; i < sorted.length; i++) {
        const d = Math.abs(sorted[i] - exp);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      const tol = Math.max(3, step * 0.28);
      if (bi >= 0 && bd <= tol) {
        matched++;
        err += bd / step;
        lines.push(Math.round(sorted[bi]));
      } else {
        lines.push(Math.round(exp));
        err += 1;
      }
    }
    // penalize stray extra peaks far from any expected line
    let stray = 0;
    for (const p of sorted) {
      let md = Infinity;
      for (const L of lines) md = Math.min(md, Math.abs(p - L));
      if (md > step * 0.35) stray++;
    }
    const score = matched / (n + 1) - err * 0.06 - stray * 0.08;
    if (!best || score > best.score) best = { lines, n, score };
  }
  return best;
}

/**
 * Snap fitted lines to true grid-line centers. Interior lines move to the
 * local slate centroid (fixes linear-interpolation drift and mild keystone);
 * end lines are re-derived from the interior pitch so thick frame borders
 * can't pull them off the outer grid lines.
 */
function refineLines(raw: number[], lines: number[], s: number): number[] {
  const n = lines.length - 1;
  if (n < 2) return lines;
  const prof = smooth1D(raw, 1);
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i] - lines[i - 1]);
  const pitch = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] || s / n;
  const support = (x: number): number => {
    const i = Math.max(0, Math.min(s - 1, Math.round(x)));
    return prof[i];
  };
  const centroidNear = (x: number, radius: number): number => {
    const a = Math.max(0, Math.floor(x - radius));
    const b = Math.min(s - 1, Math.ceil(x + radius));
    let sw = 0;
    let sx = 0;
    let peak = 0;
    for (let i = a; i <= b; i++) peak = Math.max(peak, prof[i]);
    const floor = peak * 0.4;
    for (let i = a; i <= b; i++) {
      const w = Math.max(0, prof[i] - floor);
      sw += w;
      sx += w * i;
    }
    return sw > 0 ? sx / sw : x;
  };
  const bestNear = (x: number, radius: number): number => {
    // argmax with centroid tie-break: trust pitch, verify locally
    let bi = Math.max(0, Math.min(s - 1, Math.round(x)));
    for (let i = Math.max(0, Math.floor(x - radius)); i <= Math.min(s - 1, x + radius); i++) {
      if (prof[i] > prof[bi]) bi = i;
    }
    return centroidNear(bi, Math.max(2, pitch * 0.12));
  };
  const out = lines.slice();
  const rIn = Math.max(3, pitch * 0.38);
  for (let k = 1; k < n; k++) {
    const c = centroidNear(out[k], rIn);
    // only accept snaps with real slate support behind them
    if (support(c) > 0.06) out[k] = c;
  }
  // re-derive interior pitch from trusted (supported) interior lines
  const trusted: number[] = [];
  for (let k = 1; k < n; k++) if (support(out[k]) > 0.06) trusted.push(out[k]);
  let p = pitch;
  if (trusted.length >= 2) {
    const tg: number[] = [];
    for (let i = 1; i < trusted.length; i++) tg.push(trusted[i] - trusted[i - 1]);
    tg.sort((a, b) => a - b);
    p = tg[Math.floor(tg.length / 2)];
  } else if (trusted.length === 1) {
    p = pitch;
  }
  if (p > 6) {
    out[0] = bestNear(out[1] - p, p * 0.35);
    out[n] = bestNear(out[n - 1] + p, p * 0.35);
  }
  return out.map((v) => Math.max(0, Math.min(s - 1, Math.round(v))));
}

export function detectGridOnSquare(img: Uint8ClampedArray, s: number): { v: number[]; h: number[]; n: number; score: number } | null {
  let best: { v: number[]; h: number[]; n: number; score: number; loose: boolean } | null = null;
  for (const loose of [false, true]) {
    const { cols, rows } = profilesOf(img, s, loose);
    // smooth ~ line width scale
    const r = Math.max(1, Math.floor(s / 300));
    const cs = smooth1D(cols, r);
    const rs = smooth1D(rows, r);
    const meanC = cs.reduce((a, b) => a + b, 0) / cs.length;
    const meanR = rs.reduce((a, b) => a + b, 0) / rs.length;
    const maxC = Math.max(...cs);
    const maxR = Math.max(...rs);
    const thrC = Math.min(maxC * 0.45, meanC + (maxC - meanC) * 0.35);
    const thrR = Math.min(maxR * 0.45, meanR + (maxR - meanR) * 0.35);
    const pc = peakGroups(cs, Math.max(0.08, thrC));
    const pr = peakGroups(rs, Math.max(0.08, thrR));
    const fv = fitGrid(pc, s);
    const fh = fitGrid(pr, s);
    if (fv && fh && fv.n === fh.n) {
      const score = fv.score + fh.score + (loose ? -0.05 : 0.05);
      if (!best || score > best.score) best = { v: fv.lines, h: fh.lines, n: fv.n, score, loose };
    }
  }
  if (!best || best.score < 0.55 || best.n < 4 || best.n > 14) return null;
  // Snap to true line centers with the winning tier's raw profiles.
  const prof = profilesOf(img, s, best.loose);
  best.v = refineLines(prof.cols, best.v, s);
  best.h = refineLines(prof.rows, best.h, s);
  return best;
}

// ---------------------------------------------------------------------------
// Cell sampling + classification
// ---------------------------------------------------------------------------

interface CellSample {
  r: number;
  c: number;
  lab: Lab;
  rgb: RGB;
  /** Background luminance (median of unmarked-looking pixels). */
  bgL: number;
  whiteFrac: number;
  darkFrac: number;
  blueDarkFrac: number;
  diagWhite: number;
  plainWhite: number;
  /** Fraction of pixels much brighter than this cell's own background. */
  brightFrac: number;
  /** Bright fraction on each diagonal stroke (d1: \, d2: /) and in plain center. */
  d1Bright: number;
  d2Bright: number;
  plainBright: number;
}

function sampleCells(img: Uint8ClampedArray, s: number, v: number[], h: number[], n: number): CellSample[] {
  const cells: CellSample[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x0 = v[c];
      const x1 = v[c + 1];
      const y0 = h[r];
      const y1 = h[r + 1];
      const cw = Math.max(4, x1 - x0);
      const ch = Math.max(4, y1 - y0);
      const ix0 = Math.round(x0 + cw * 0.24);
      const ix1 = Math.round(x1 - cw * 0.24);
      const iy0 = Math.round(y0 + ch * 0.24);
      const iy1 = Math.round(y1 - ch * 0.24);
      const bgRs: number[] = [];
      const bgGs: number[] = [];
      const bgBs: number[] = [];
      let white = 0;
      let dark = 0;
      let blueDark = 0;
      let tot = 0;
      // diagonal X bands (absolute-white accounting)
      let diagW = 0;
      let diagT = 0;
      let plainW = 0;
      let plainT = 0;
      const cx = (ix0 + ix1) / 2;
      const cy = (iy0 + iy1) / 2;
      const half = Math.min(ix1 - ix0, iy1 - iy0) / 2 || 1;
      // stash interior luminances + band membership for the bg-relative pass
      const Ls: number[] = [];
      const bands: number[] = []; // 1 = d1 (\), 2 = d2 (/), 0 = plain, -1 = other
      for (let y = iy0; y <= iy1; y += 2) {
        for (let x = ix0; x <= ix1; x += 2) {
          const o = (y * s + x) * 4;
          const R = img[o];
          const G = img[o + 1];
          const B = img[o + 2];
          tot++;
          const L = lum(R, G, B);
          const wht = isWhitePx(R, G, B);
          if (wht) white++;
          if (isDarkInk(R, G, B)) dark++;
          if (isBlueDark(R, G, B) && lum(R, G, B) < 150) blueDark++;
          const dx = (x - cx) / half;
          const dy = (y - cy) / half;
          const onD1 = Math.abs(dx - dy) < 0.3 && Math.abs(dx) < 0.95;
          const onD2 = Math.abs(dx + dy) < 0.3 && Math.abs(dx) < 0.95;
          const onDiag = onD1 || onD2;
          if (onDiag) {
            diagT++;
            if (wht) diagW++;
          } else if (Math.abs(dx) < 0.6 && Math.abs(dy) < 0.6) {
            plainT++;
            if (wht) plainW++;
          }
          Ls.push(L);
          bands.push(onD1 && !onD2 ? 1 : onD2 && !onD1 ? 2 : !onDiag && Math.abs(dx) < 0.6 && Math.abs(dy) < 0.6 ? 0 : -1);
          // Background ring: pixels hugging the inner window border. X strokes
          // cross it only in thin arcs and icon art never reaches it, so the
          // median is the true cell color for empty, X, AND icon cells alike.
          // Only slate (grid strays) is excluded; white/dark pixels are a
          // minority here and the median ignores them. (Absolute-white tests
          // must NOT filter bg: pale pastel cells would lose every sample.)
          const onRing = x - ix0 < 3 || ix1 - x < 3 || y - iy0 < 3 || iy1 - y < 3;
          if (onRing && !isSlate(R, G, B, true)) {
            bgRs.push(R);
            bgGs.push(G);
            bgBs.push(B);
          }
        }
      }
      const med = (a: number[]) => {
        if (!a.length) return 0;
        const t = a.slice().sort((p, q) => p - q);
        return t[Math.floor(t.length / 2)];
      };
      let rgb: RGB = [med(bgRs), med(bgGs), med(bgBs)];
      if (bgRs.length < 8) {
        // Heavily marked (or misaligned) window: median of center pixels with
        // white/slate/dark excluded, so X strokes and icon ink can't drag the
        // color to white or navy the way a raw mean would.
        const cR: number[] = [];
        const cG: number[] = [];
        const cB: number[] = [];
        for (let y = Math.round(cy - half * 0.4); y <= Math.round(cy + half * 0.4); y += 1) {
          for (let x = Math.round(cx - half * 0.4); x <= Math.round(cx + half * 0.4); x += 1) {
            if (x < 0 || y < 0 || x >= s || y >= s) continue;
            const o = (y * s + x) * 4;
            const R = img[o];
            const G = img[o + 1];
            const B = img[o + 2];
            if (isWhitePx(R, G, B) || isDarkInk(R, G, B) || isSlate(R, G, B, true)) continue;
            cR.push(R);
            cG.push(G);
            cB.push(B);
          }
        }
        if (cR.length >= 4) rgb = [med(cR), med(cG), med(cB)];
        else if (bgRs.length > 0) rgb = [med(bgRs), med(bgGs), med(bgBs)];
        else rgb = [150, 150, 150]; // total washout: neutral, clusters by neighbors
      }
      const bgL = lum(rgb[0], rgb[1], rgb[2]);
      // bg-relative brightness pass: strokes/fills stand out from THIS cell's color
      let bright = 0;
      let d1B = 0;
      let d1T = 0;
      let d2B = 0;
      let d2T = 0;
      let plB = 0;
      let plT = 0;
      for (let i = 0; i < Ls.length; i++) {
        const isBright = Ls[i] - bgL > 28;
        if (isBright) bright++;
        if (bands[i] === 1) {
          d1T++;
          if (isBright) d1B++;
        } else if (bands[i] === 2) {
          d2T++;
          if (isBright) d2B++;
        } else if (bands[i] === 0) {
          plT++;
          if (isBright) plB++;
        }
      }
      cells.push({
        r,
        c,
        rgb,
        lab: rgbToLab(rgb[0], rgb[1], rgb[2]),
        bgL,
        whiteFrac: tot ? white / tot : 0,
        darkFrac: tot ? dark / tot : 0,
        blueDarkFrac: tot ? blueDark / tot : 0,
        diagWhite: diagT ? diagW / diagT : 0,
        plainWhite: plainT ? plainW / plainT : 0,
        brightFrac: Ls.length ? bright / Ls.length : 0,
        d1Bright: d1T ? d1B / d1T : 0,
        d2Bright: d2T ? d2B / d2T : 0,
        plainBright: plT ? plB / plT : 0,
      });
    }
  }
  return cells;
}

function otsuThreshold(vals: number[]): number {
  if (vals.length < 4) return 0.05;
  const s = vals.slice().sort((a, b) => a - b);
  let bestT = s[Math.floor(s.length / 2)];
  let bestV = -1;
  for (let i = 1; i < s.length - 1; i++) {
    const t = (s[i] + s[i + 1]) / 2;
    const a = s.slice(0, i + 1);
    const b = s.slice(i + 1);
    const ma = a.reduce((x, y) => x + y, 0) / a.length;
    const mb = b.reduce((x, y) => x + y, 0) / b.length;
    const va = a.reduce((x, y) => x + (y - ma) * (y - ma), 0) / a.length;
    const vb = b.reduce((x, y) => x + (y - mb) * (y - mb), 0) / b.length;
    const w0 = a.length / s.length;
    const w1 = b.length / s.length;
    const between = w0 * w1 * (ma - mb) * (ma - mb);
    const within = w0 * va + w1 * vb + 1e-9;
    const score = between / within;
    if (score > bestV) {
      bestV = score;
      bestT = t;
    }
  }
  return bestT;
}

function classifyMarks(cells: CellSample[]): {
  kind: ("empty" | "x" | "crown")[];
  xCount: number;
  crownCount: number;
  conf: number[];
} {
  const darks = cells.map((c) => c.darkFrac + c.blueDarkFrac * 0.7);
  const otsuD = otsuThreshold(darks);
  const iconThr = Math.min(0.075, Math.max(0.028, otsuD));
  const kind: ("empty" | "x" | "crown")[] = [];
  const conf: number[] = [];
  let xCount = 0;
  let crownCount = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const iconScore = c.darkFrac + c.blueDarkFrac * 0.7;
    // Dodoco icon veto first: dark ring/ink + white face fill. The fill check
    // stops dark-but-flat cells from matching, the ring check stops X cells.
    if (iconScore >= iconThr && c.darkFrac >= 0.02 && c.brightFrac >= 0.08) {
      kind.push("crown");
      conf.push(Math.min(1, iconScore / 0.12));
      crownCount++;
      continue;
    }
    // X mark: BOTH diagonal strokes brighter than this cell's own background,
    // plain center mostly background. Bg-relative, so light pastel cells
    // (bright everywhere) and empty cells (bright nowhere) both fail.
    const strokes = Math.min(c.d1Bright, c.d2Bright);
    const strokeAvg = (c.d1Bright + c.d2Bright) / 2;
    const isX =
      strokes >= 0.1 &&
      strokeAvg > c.plainBright + 0.04 &&
      c.plainBright <= 0.4 &&
      c.brightFrac >= 0.02 &&
      c.brightFrac <= 0.6;
    if (isX) {
      kind.push("x");
      conf.push(Math.min(1, strokes / 0.45));
      xCount++;
    } else {
      kind.push("empty");
      // confidence that the cell is NOT a missed mark (low = uncertain)
      conf.push(Math.min(1, Math.max(0.05, 1 - strokeAvg * 2 - iconScore * 8)));
    }
  }
  return { kind, xCount, crownCount, conf };
}

// ---------------------------------------------------------------------------
// Region clustering (k = n) in Lab + connectivity repair
// ---------------------------------------------------------------------------

function kmeans(cells: CellSample[], k: number): { assign: number[]; centers: Lab[]; sse: number } {
  // k-means++ seeded, deterministic via fixed stride
  const pts = cells.map((c) => c.lab);
  const centers: Lab[] = [];
  centers.push([...pts[Math.floor(pts.length / 3)]] as Lab);
  while (centers.length < k) {
    const d2 = pts.map((p) => {
      let m = Infinity;
      for (const c of centers) {
        const d = labDist(p, c);
        m = Math.min(m, d * d);
      }
      return m;
    });
    const sum = d2.reduce((a, b) => a + b, 0) || 1;
    let target = sum * ((centers.length * 0.6180339887) % 1);
    let pick = 0;
    for (let i = 0; i < d2.length; i++) {
      target -= d2[i];
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    centers.push([...pts[pick]] as Lab);
  }
  const assign = new Array(pts.length).fill(0);
  for (let it = 0; it < 25; it++) {
    let moved = false;
    for (let i = 0; i < pts.length; i++) {
      let bi = 0;
      let bd = Infinity;
      for (let j = 0; j < k; j++) {
        const d = labDist(pts[i], centers[j]);
        if (d < bd) {
          bd = d;
          bi = j;
        }
      }
      if (assign[i] !== bi) {
        assign[i] = bi;
        moved = true;
      }
    }
    const sums: number[][] = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < pts.length; i++) {
      const a = assign[i];
      sums[a][0] += pts[i][0];
      sums[a][1] += pts[i][1];
      sums[a][2] += pts[i][2];
      sums[a][3]++;
    }
    for (let j = 0; j < k; j++) {
      if (sums[j][3] > 0) centers[j] = [sums[j][0] / sums[j][3], sums[j][1] / sums[j][3], sums[j][2] / sums[j][3]];
    }
    if (!moved) break;
  }
  let sse = 0;
  for (let i = 0; i < pts.length; i++) {
    const d = labDist(pts[i], centers[assign[i]]);
    sse += d * d;
  }
  return { assign, centers, sse };
}

function clusterRegions(cells: CellSample[], n: number): { assign: number[]; centers: Lab[] } | null {
  let best: { assign: number[]; centers: Lab[]; sse: number } | null = null;
  for (let restart = 0; restart < 4; restart++) {
    // rotate seed by shifting cell order
    const order = cells.map((_, i) => (i + restart * 13) % cells.length);
    const ordered = order.map((i) => cells[i]);
    const res = kmeans(ordered, n);
    // unshuffle assign
    const assign = new Array(cells.length);
    for (let i = 0; i < order.length; i++) assign[order[i]] = res.assign[i];
    const cand = { assign, centers: res.centers, sse: res.sse };
    if (!best || cand.sse < best.sse) best = cand;
  }
  if (!best) return null;
  // fix empty clusters by splitting largest
  const counts = new Array(n).fill(0);
  for (const a of best.assign) counts[a]++;
  for (let j = 0; j < n; j++) {
    if (counts[j] === 0) {
      // steal farthest cell from largest cluster
      let big = 0;
      for (let k = 1; k < n; k++) if (counts[k] > counts[big]) big = k;
      let far = -1;
      let fd = -1;
      for (let i = 0; i < cells.length; i++) {
        if (best.assign[i] !== big) continue;
        const d = labDist(cells[i].lab, best.centers[big]);
        if (d > fd) {
          fd = d;
          far = i;
        }
      }
      if (far >= 0) {
        best.assign[far] = j;
        counts[big]--;
        counts[j]++;
        best.centers[j] = [...cells[far].lab] as Lab;
      }
    }
  }
  // connectivity repair: split orthogonally-disconnected blobs, merge splinters
  const assign = best.assign.slice();
  const compOf = new Array(cells.length).fill(-1);
  let compCount = 0;
  const compCells: number[][] = [];
  for (let i = 0; i < cells.length; i++) {
    if (compOf[i] !== -1) continue;
    const region = assign[i];
    const q = [i];
    compOf[i] = compCount;
    const members: number[] = [i];
    while (q.length) {
      const p = q.pop()!;
      const pr = cells[p].r;
      const pc = cells[p].c;
      const nb: number[] = [];
      if (pr > 0) nb.push(p - n);
      if (pr + 1 < n) nb.push(p + n);
      if (pc > 0) nb.push(p - 1);
      if (pc + 1 < n) nb.push(p + 1);
      for (const m of nb) {
        if (compOf[m] === -1 && assign[m] === region) {
          compOf[m] = compCount;
          members.push(m);
          q.push(m);
        }
      }
    }
    compCells.push(members);
    compCount++;
  }
  // group components by region, keep largest, merge rest to best neighbor color
  const byRegion = new Map<number, number[]>();
  compCells.forEach((members, ci) => {
    const r = assign[members[0]];
    if (!byRegion.has(r)) byRegion.set(r, []);
    byRegion.get(r)!.push(ci);
  });
  for (const [, comps] of byRegion) {
    if (comps.length <= 1) continue;
    comps.sort((a, b) => compCells[b].length - compCells[a].length);
    for (let k = 1; k < comps.length; k++) {
      const members = compCells[comps[k]];
      if (members.length > n * 1.5) continue; // genuine split from bad clustering; leave it
      for (const m of members) {
        // nearest different-region neighbor color wins
        const pr = cells[m].r;
        const pc = cells[m].c;
        let bi = assign[m];
        let bd = Infinity;
        const tryReg = (rr: number, cc: number) => {
          if (rr < 0 || cc < 0 || rr >= n || cc >= n) return;
          const j = rr * n + cc;
          const reg = assign[j];
          if (reg === assign[m]) return;
          const d = labDist(cells[m].lab, best.centers[reg]);
          if (d < bd) {
            bd = d;
            bi = reg;
          }
        };
        tryReg(pr - 1, pc);
        tryReg(pr + 1, pc);
        tryReg(pr, pc - 1);
        tryReg(pr, pc + 1);
        assign[m] = bi;
      }
    }
  }
  // remap to dense 0..n-1 sorted by size desc for stable output
  const size = new Array(n).fill(0);
  for (const a of assign) size[a]++;
  const orderIds = Array.from({ length: n }, (_, i) => i).sort((a, b) => size[b] - size[a]);
  const remap = new Array(n);
  orderIds.forEach((old, ni) => (remap[old] = ni));
  const finalAssign = assign.map((a) => remap[a]);
  const finalCenters: Lab[] = new Array(n);
  orderIds.forEach((old, ni) => (finalCenters[ni] = best!.centers[old]));
  // must still have exactly n distinct
  if (new Set(finalAssign).size !== n) return null;
  return { assign: finalAssign, centers: finalCenters };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

function fail(error: string): ExtractResult {
  return { ok: false, puzzle: null, boardSize: 0, lineCounts: { v: 0, h: 0 }, clusterCount: 0, marks: 0, error };
}

interface Candidate {
  puzzle: PuzzleInput;
  n: number;
  v: number;
  h: number;
  clusters: number;
  marks: number;
  score: number;
}

export async function extractBoardFromFile(file: File): Promise<ExtractResult> {
  let objectUrl = "";
  try {
    objectUrl = URL.createObjectURL(file);
    const img = await loadImage(objectUrl);
    const maxSide = 1000;
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(8, Math.round(img.naturalWidth * scale));
    const h = Math.max(8, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return fail("canvas 2d is not available in this browser");
    ctx.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(objectUrl);
    objectUrl = "";
    const data = ctx.getImageData(0, 0, w, h).data;
    return extractFromPixels(data, w, h);
  } catch (e) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    return fail(e instanceof Error ? e.message : "could not read that image");
  }
}

export interface HypoDebug {
  quad: Pt[];
  area: number;
  strict: boolean;
  grid: { n: number; v: number[]; h: number[]; score: number } | null;
  gridError: string | null;
  clusterCount: number;
  xCount: number;
  crownCount: number;
  score: number | null;
}

export interface BestDebug {
  n: number;
  v: number[];
  h: number[];
  quad: Pt[];
  warpSize: number;
  rgb: RGB[];
  lab: Lab[];
  assign: number[];
  kinds: Array<"empty" | "x" | "crown">;
  whiteFrac: number[];
  darkFrac: number[];
  diagWhite: number[];
  brightFrac: number[];
  d1Bright: number[];
  d2Bright: number[];
  plainBright: number[];
  /** 0..1 confidence for the chosen mark kind per cell. */
  markConf: number[];
}

export interface ExtractDebug {
  hypos: HypoDebug[];
  best: BestDebug | null;
  stage: string;
}

/** DOM-free core: testable with raw buffers, owns all resilience logic. */
export function extractFromPixels(data: Uint8ClampedArray, w: number, h: number): ExtractResult {
  return extractCore(data, w, h, undefined);
}

/** Same as extractFromPixels but also returns per-stage diagnostics for tooling. */
export function debugExtract(
  data: Uint8ClampedArray,
  w: number,
  h: number,
): { result: ExtractResult; debug: ExtractDebug } {
  const debug: ExtractDebug = { hypos: [], best: null, stage: "" };
  const result = extractCore(data, w, h, debug);
  return { result, debug };
}

function extractCore(data: Uint8ClampedArray, w: number, h: number, dbg: ExtractDebug | undefined): ExtractResult {
  const hypos = boardHypos(data, w, h);
  const WARP = 720;
  let best: Candidate | null = null;
  let bestDetail: BestDebug | null = null;
  let dbgV = 0;
  let dbgH = 0;
  let dbgClusters = 0;
  let dbgMarks = 0;
  let dbgN = 0;
  let stage = "no board-like region found";

  for (const hypo of hypos) {
    const hd: HypoDebug = {
      quad: hypo.quad,
      area: hypo.area,
      strict: hypo.strict,
      grid: null,
      gridError: null,
      clusterCount: 0,
      xCount: 0,
      crownCount: 0,
      score: null,
    };
    const warped = warpToSquare(data, w, h, hypo.quad, WARP);
    if (!warped) {
      hd.gridError = "warp failed";
      dbg?.hypos.push(hd);
      continue;
    }
    const grid = detectGridOnSquare(warped, WARP);
    if (!grid) {
      stage = `grid lines unreadable in best crop (try a sharper, straighter shot)`;
      hd.gridError = stage;
      dbg?.hypos.push(hd);
      continue;
    }
    hd.grid = { n: grid.n, v: grid.v.slice(), h: grid.h.slice(), score: grid.score };
    dbgV = grid.v.length;
    dbgH = grid.h.length;
    dbgN = grid.n;
    const cells = sampleCells(warped, WARP, grid.v, grid.h, grid.n);
    const clustered = clusterRegions(cells, grid.n);
    if (!clustered) {
      stage = `found ${grid.n}x${grid.n} grid but region colors would not split into ${grid.n} groups`;
      hd.gridError = stage;
      dbg?.hypos.push(hd);
      continue;
    }
    dbgClusters = new Set(clustered.assign).size;
    hd.clusterCount = dbgClusters;
    const marks = classifyMarks(cells);
    dbgMarks = marks.xCount + marks.crownCount;
    hd.xCount = marks.xCount;
    hd.crownCount = marks.crownCount;
    // color separation quality: mean inter-center distance vs intra spread
    let inter = 0;
    let pairs = 0;
    for (let a = 0; a < clustered.centers.length; a++) {
      for (let b = a + 1; b < clustered.centers.length; b++) {
        inter += labDist(clustered.centers[a], clustered.centers[b]);
        pairs++;
      }
    }
    inter /= Math.max(1, pairs);
    let intra = 0;
    for (let i = 0; i < cells.length; i++) intra += labDist(cells[i].lab, clustered.centers[clustered.assign[i]]);
    intra /= Math.max(1, cells.length);
    const colorScore = Math.min(1, inter / 28) - Math.min(0.5, intra / 60);

    const regions: number[][] = [];
    const initial: string[][] = [];
    for (let r = 0; r < grid.n; r++) {
      const rr: number[] = [];
      const ir: string[] = [];
      for (let c = 0; c < grid.n; c++) {
        const idx = r * grid.n + c;
        rr.push(clustered.assign[idx]);
        const k = marks.kind[idx];
        ir.push(k === "crown" ? "C" : k === "x" ? "." : "?");
      }
      regions.push(rr);
      initial.push(ir);
    }
    // palette from cluster mean rgb
    const acc: number[][] = Array.from({ length: grid.n }, () => [0, 0, 0, 0]);
    for (let i = 0; i < cells.length; i++) {
      const a = clustered.assign[i];
      acc[a][0] += cells[i].rgb[0];
      acc[a][1] += cells[i].rgb[1];
      acc[a][2] += cells[i].rgb[2];
      acc[a][3]++;
    }
    const palette = acc.map((a) =>
      a[3] ? toHex([a[0] / a[3], a[1] / a[3], a[2] / a[3]]) : "#BCCEE2",
    );
    const score = grid.score * 2 + colorScore + Math.min(0.3, (marks.xCount + marks.crownCount) * 0.01);
    const cand: Candidate = {
      puzzle: {
        size: grid.n,
        crownsPerRow: 2,
        crownsPerColumn: 2,
        crownsPerRegion: 2,
        regions,
        initial,
        palette,
      },
      n: grid.n,
      v: grid.v.length,
      h: grid.h.length,
      clusters: grid.n,
      marks: marks.xCount + marks.crownCount,
      score,
    };
    hd.score = score;
    if (dbg) dbg.hypos.push(hd);
    if (!best || cand.score > best.score) {
      best = cand;
      bestDetail = {
        n: grid.n,
        v: grid.v.slice(),
        h: grid.h.slice(),
        quad: hypo.quad,
        warpSize: WARP,
        rgb: cells.map((c) => c.rgb),
        lab: cells.map((c) => c.lab),
        assign: clustered.assign.slice(),
        kinds: marks.kind.slice(),
        whiteFrac: cells.map((c) => c.whiteFrac),
        darkFrac: cells.map((c) => c.darkFrac + c.blueDarkFrac * 0.7),
        diagWhite: cells.map((c) => c.diagWhite),
        brightFrac: cells.map((c) => c.brightFrac),
        d1Bright: cells.map((c) => c.d1Bright),
        d2Bright: cells.map((c) => c.d2Bright),
        plainBright: cells.map((c) => c.plainBright),
        markConf: marks.conf.slice(),
      };
    }
  }
  if (dbg) {
    dbg.best = bestDetail;
    dbg.stage = stage;
  }

  if (best) {
    return {
      ok: true,
      puzzle: best.puzzle,
      boardSize: best.n,
      lineCounts: { v: best.v, h: best.h },
      clusterCount: best.clusters,
      marks: best.marks,
      error: null,
    };
  }
  return {
    ok: false,
    puzzle: null,
    boardSize: dbgN,
    lineCounts: { v: dbgV, h: dbgH },
    clusterCount: dbgClusters,
    marks: dbgMarks,
    error: `${stage}. Frame the whole board (tilted phone photos are OK) with the grid clearly visible.`,
  };
}
