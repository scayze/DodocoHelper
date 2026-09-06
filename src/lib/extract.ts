import type { PuzzleInput } from "../core/types.js";
import {
  getOpenCV,
  KMEANS_PP_CENTERS,
  loadOpenCV,
  TERM_CRITERIA_EPS,
  TERM_CRITERIA_MAX_ITER,
} from "./opencv.js";
import type { Mat } from "@techstark/opencv-js";

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
  markConf: number[];
}

export interface ExtractDebug {
  hypos: HypoDebug[];
  best: BestDebug | null;
  stage: string;
}

const MAX_SIDE = 1000;
const WARP = 720;

// ---------------------------------------------------------------------------
// Math / colour helpers
// ---------------------------------------------------------------------------

function toHex([r, g, b]: RGB): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0").toUpperCase();
  return `#${h(r)}${h(g)}${h(b)}`;
}

function rgbToLab(r: number, g: number, b: number): Lab {
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

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function polyArea(q: Pt[]): number {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i];
    const r = q[(i + 1) % q.length];
    a += p.x * r.y - r.x * p.y;
  }
  return a / 2;
}

function quadAspect(q: Pt[]): number {
  const w = (Math.hypot(q[0].x - q[1].x, q[0].y - q[1].y) + Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y)) / 2;
  const h = (Math.hypot(q[1].x - q[2].x, q[1].y - q[2].y) + Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y)) / 2;
  return Math.max(w, h) / Math.max(1, Math.min(w, h));
}

/** Sort a quad's four points into TL, TR, BR, BL clockwise. */
function orderQuad(q: Pt[]): Pt[] {
  const sorted = q.slice().sort((a, b) => a.x + a.y - (b.x + b.y));
  const tl = sorted[0];
  const br = sorted[sorted.length - 1];
  const rem = sorted.slice(1, 3).sort((a, b) => a.y - b.y);
  return [tl, { x: rem[1].x, y: rem[1].y }, br, { x: rem[0].x, y: rem[0].y }];
}

// ---------------------------------------------------------------------------
// Browser entry: decode file -> draw to canvas -> pass RGBA pixels in.
// ---------------------------------------------------------------------------

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not decode that image file"));
    img.src = src;
  });
}

export async function extractBoardFromFile(file: File): Promise<ExtractResult> {
  let objectUrl = "";
  try {
    objectUrl = URL.createObjectURL(file);
    const img = await loadImage(objectUrl);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
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

export function extractFromPixels(data: Uint8ClampedArray, w: number, h: number): ExtractResult {
  return extractCore(data, w, h, undefined);
}

export function debugExtract(data: Uint8ClampedArray, w: number, h: number): {
  result: ExtractResult;
  debug: ExtractDebug;
} {
  const debug: ExtractDebug = { hypos: [], best: null, stage: "" };
  const result = extractCore(data, w, h, debug);
  return { result, debug };
}

function fail(error: string): ExtractResult {
  return { ok: false, puzzle: null, boardSize: 0, lineCounts: { v: 0, h: 0 }, clusterCount: 0, marks: 0, error };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

interface Candidate {
  puzzle: PuzzleInput;
  n: number;
  v: number;
  h: number;
  clusters: number;
  marks: number;
  score: number;
}

function extractCore(data: Uint8ClampedArray, w: number, h: number, dbg: ExtractDebug | undefined): ExtractResult {
  // loadOpenCV() is async; we need the runtime synchronously here. The
  // browser pipeline awaits it once in main.ts before calling
  // extractFromPixels. The Node test harness awaits loadOpenCV() at the
  // module level (see tests/*). If the runtime is missing, fail cleanly.
  let cv: ReturnType<typeof getOpenCV>;
  try {
    cv = getOpenCV();
  } catch {
    return fail("OpenCV.js runtime not loaded — please reload the page");
  }
  // Push the RGBA pixels into a BGR Mat for the OpenCV stages.
  const src = new cv.Mat(h, w, cv.CV_8UC4);
  src.data.set(data);
  const bgr = new cv.Mat();
  cv.cvtColor(src, bgr, cv.COLOR_RGBA2BGR);
  src.delete();

  const hypos = findBoardQuads(bgr, w, h);
  bgr.delete();

  let best: Candidate | null = null;
  let bestDetail: BestDebug | null = null;
  let stage = "no board-like region found";
  for (const hypo of hypos) {
    const hd: HypoDebug = {
      quad: hypo.quad,
      area: hypo.area,
      strict: true,
      grid: null,
      gridError: null,
      clusterCount: 0,
      xCount: 0,
      crownCount: 0,
      score: null,
    };
    // Warp the RGBA bytes (via OpenCV perspective transform) and pull the
    // result back into a plain typed array so the rest of the pipeline
    // doesn't need any more Mat handles.
    const srcForWarp = new cv.Mat(h, w, cv.CV_8UC4);
    srcForWarp.data.set(data);
    const { warped, quad } = warpQuad(srcForWarp, hypo.quad, WARP);
    srcForWarp.delete();
    // Read RGBA pixels straight out of the warp result.
    const pixels = new Uint8ClampedArray(warped.data);
    warped.delete();

    const grid = detectGrid(pixels, WARP, w < 425 ? 10 : null);
    if (!grid) {
      stage = "grid lines unreadable in best crop (try a sharper, straighter shot)";
      hd.gridError = stage;
      dbg?.hypos.push(hd);
      continue;
    }
    hd.grid = { n: grid.n, v: grid.v.slice(), h: grid.h.slice(), score: grid.score };
    const cells = sampleCells(pixels, WARP, grid.v, grid.h, grid.n);
    const clustered = clusterRegions(cells, grid.n);
    if (!clustered) {
      stage = `found ${grid.n}x${grid.n} grid but region colors would not split into ${grid.n} groups`;
      hd.gridError = stage;
      dbg?.hypos.push(hd);
      continue;
    }
    hd.clusterCount = new Set(clustered.assign).size;
    const marks = classifyMarks(cells);
    hd.xCount = marks.xCount;
    hd.crownCount = marks.crownCount;

    // Score: prefer well-separated regions, more lines matched, and a
    // sensible mark count.
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
    const acc: number[][] = Array.from({ length: grid.n }, () => [0, 0, 0, 0]);
    for (let i = 0; i < cells.length; i++) {
      const a = clustered.assign[i];
      acc[a][0] += cells[i].rgb[0];
      acc[a][1] += cells[i].rgb[1];
      acc[a][2] += cells[i].rgb[2];
      acc[a][3]++;
    }
    const palette = acc.map((a) => (a[3] ? toHex([a[0] / a[3], a[1] / a[3], a[2] / a[3]]) : "#BCCEE2"));
    const score =
      hypo.score + colorScore + Math.min(0.3, (marks.xCount + marks.crownCount) * 0.01);
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
    dbg?.hypos.push(hd);
    if (!best || cand.score > best.score) {
      best = cand;
      bestDetail = {
        n: grid.n,
        v: grid.v.slice(),
        h: grid.h.slice(),
        quad,
        warpSize: WARP,
        rgb: cells.map((c) => c.rgb),
        lab: cells.map((c) => c.lab),
        assign: clustered.assign.slice(),
        kinds: marks.kind.slice(),
        whiteFrac: cells.map((c) => c.whiteFrac),
        darkFrac: cells.map((c) => c.darkFrac),
        diagWhite: cells.map((c) => (c.diagWhiteD1 + c.diagWhiteD2) / 2),
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
    boardSize: 0,
    lineCounts: { v: 0, h: 0 },
    clusterCount: 0,
    marks: 0,
    error: `${stage}. Frame the whole board (tilted phone photos are OK) with the grid clearly visible.`,
  };
}

// ---------------------------------------------------------------------------
// Stage 1: board localization (OpenCV contours)
// ---------------------------------------------------------------------------

interface BoardHypo {
  quad: Pt[];
  area: number;
  score: number;
}

function findBoardQuads(bgr: Mat, w: number, h: number): BoardHypo[] {
  const cv = getOpenCV();
  // Step 1: build a "slate frame" mask. The grid lines and outer frame of
  // the puzzle are a recognisable slate grey; everything else is cell
  // background or icons. We work in Lab so the threshold is robust under
  // white balance shifts.
  const lab = new cv.Mat();
  cv.cvtColor(bgr, lab, cv.COLOR_BGR2Lab);
  const lCh = new cv.Mat();
  const aCh = new cv.Mat();
  const bCh = new cv.Mat();
  const channels = new cv.MatVector();
  channels.push_back(lCh);
  channels.push_back(aCh);
  channels.push_back(bCh);
  cv.split(lab, channels);
  // Slate pixels: L in [50..170], A near 0 (slightly cool), B slightly +
  // for the slight blue cast.
  const lower = new cv.Mat(lab.rows, lab.cols, lab.type(), new cv.Scalar(50, 110, 110, 0));
  const upper = new cv.Mat(lab.rows, lab.cols, lab.type(), new cv.Scalar(170, 140, 145, 0));
  const mask = new cv.Mat();
  cv.inRange(lab, lower, upper, mask);
  lower.delete();
  upper.delete();
  // Close small gaps in the frame so the outer rectangle is one connected
  // component even when the cell colours bleed into the grid intersections.
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  const closed = new cv.Mat();
  cv.morphologyEx(mask, closed, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), 2, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
  mask.delete();
  kernel.delete();
  lCh.delete();
  aCh.delete();
  bCh.delete();
  channels.delete();
  lab.delete();

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  closed.delete();

  const imgArea = w * h;
  const candidates: BoardHypo[] = [];
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const peri = cv.arcLength(c, true);
    if (peri < 80) {
      c.delete();
      continue;
    }
    const approx = new cv.Mat();
    cv.approxPolyDP(c, approx, 0.02 * peri, true);
    if (approx.rows !== 4 || approx.channels() !== 1) {
      approx.delete();
      c.delete();
      continue;
    }
    const pts: Pt[] = [];
    for (let k = 0; k < 4; k++) {
      pts.push({ x: approx.data32F[k * 2], y: approx.data32F[k * 2 + 1] });
    }
    approx.delete();
    c.delete();
    const area = Math.abs(polyArea(pts));
    if (area < imgArea * 0.2) continue;
    if (quadAspect(pts) < 0.55 || quadAspect(pts) > 1.85) continue;
    const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
    const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
    const dx = (cx - w / 2) / w;
    const dy = (cy - h / 2) / h;
    const centred = 1 - Math.min(1, Math.hypot(dx, dy) * 1.6);
    const fillFrac = area / imgArea;
    const score = fillFrac * 1.4 + centred * 0.5;
    candidates.push({ quad: orderQuad(pts), area, score });
  }
  contours.delete();
  hierarchy.delete();

  candidates.sort((a, b) => b.score - a.score);
  candidates.push({
    quad: [
      { x: 0, y: 0 },
      { x: w - 1, y: 0 },
      { x: w - 1, y: h - 1 },
      { x: 0, y: h - 1 },
    ],
    area: imgArea,
    score: -1,
  });
  return candidates.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Stage 2: perspective warp
// ---------------------------------------------------------------------------

function warpQuad(rgba: Mat, srcQuad: Pt[], size: number): { warped: Mat; quad: Pt[] } {
  const cv = getOpenCV();
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, srcQuad.flatMap((p) => [p.x, p.y]));
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0,
    0,
    size - 1,
    0,
    size - 1,
    size - 1,
    0,
    size - 1,
  ]);
  const M = cv.getPerspectiveTransform(src, dst);
  const warped = new cv.Mat();
  cv.warpPerspective(rgba, warped, M, new cv.Size(size, size), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar(255, 255, 255, 0));
  src.delete();
  dst.delete();
  M.delete();
  return {
    warped,
    quad: [
      { x: 0, y: 0 },
      { x: size - 1, y: 0 },
      { x: size - 1, y: size - 1 },
      { x: 0, y: size - 1 },
    ],
  };
}

// ---------------------------------------------------------------------------
// Stage 3: grid line detection
// ---------------------------------------------------------------------------

interface GridResult {
  v: number[];
  h: number[];
  n: number;
  score: number;
}

function detectGrid(rgba: Uint8ClampedArray, size: number, preferredN: number | null = null): GridResult | null {
  const cols = new Array<number>(size).fill(0);
  const rows = new Array<number>(size).fill(0);
  const margin = Math.round(size * 0.08);
  for (let y = margin; y < size - margin; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      if (isSlate(rgba[o], rgba[o + 1], rgba[o + 2])) cols[x]++;
    }
  }
  for (let x = margin; x < size - margin; x++) {
    for (let y = 0; y < size; y++) {
      const o = (y * size + x) * 4;
      if (isSlate(rgba[o], rgba[o + 1], rgba[o + 2])) rows[y]++;
    }
  }
  const vPeaks = projectionPeaks(cols, size - margin * 2);
  const hPeaks = projectionPeaks(rows, size - margin * 2);
  // Projections are deliberately used instead of Hough here: game grid
  // lines are continuous but may have almost no Canny edge at pastel joins.
  let best: GridResult | null = null;
  // This minigame currently uses 9x9 and 10x10 boards. Pick the order from
  // the rectified board scale, then let the projection refine the individual
  // lines. This avoids interpreting a broken JPEG line as an extra grid row.
  for (let n = 9; n <= 10; n++) {
    if (preferredN !== null && n !== preferredN) continue;
    const v = fitProjection(vPeaks, n, size);
    const h = fitProjection(hPeaks, n, size);
    if (!v || !h) continue;
    const exact = (vPeaks.length === n + 1 ? 1 : 0) + (hPeaks.length === n + 1 ? 1 : 0);
    const score = gridFitScore(v, vPeaks, n, size) + gridFitScore(h, hPeaks, n, size) + exact;
    if (!best || score > best.score) best = { v, h, n, score };
  }
  return best && best.score > 0.7 ? best : null;
}

function projectionPeaks(profile: number[], span: number): number[] {
  const smooth = profile.map((_, i) => {
    let s = 0;
    for (let k = -2; k <= 2; k++) s += profile[Math.max(0, Math.min(profile.length - 1, i + k))];
    return s / 5;
  });
  const threshold = Math.max(4, Math.max(...smooth) * 0.22);
  const peaks: number[] = [];
  for (let i = 1; i < smooth.length - 1; i++) {
    if (smooth[i] < threshold || smooth[i] < smooth[i - 1] || smooth[i] < smooth[i + 1]) continue;
    if (peaks.length && i - peaks[peaks.length - 1] < Math.max(4, span / 30)) {
      if (smooth[i] > smooth[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i;
    } else peaks.push(i);
  }
  return peaks;
}

function fitProjection(peaks: number[], n: number, size: number): number[] | null {
  if (peaks.length < 5) return null;
  const first = peaks[0];
  const last = peaks[peaks.length - 1];
  if (last - first < size * 0.45) return null;
  if (peaks.length === n + 1) return peaks.slice();
  const step = (last - first) / n;
  const lines: number[] = [];
  const used = new Set<number>();
  let matched = 0;
  for (let k = 0; k <= n; k++) {
    const expected = first + k * step;
    let nearest = expected;
    let distance = Infinity;
    let nearestIndex = -1;
    for (let pi = 0; pi < peaks.length; pi++) {
      if (used.has(pi)) continue;
      const peak = peaks[pi];
      if (Math.abs(peak - expected) < distance) {
        nearest = peak;
        distance = Math.abs(peak - expected);
        nearestIndex = pi;
      }
    }
    if (nearestIndex >= 0 && distance < step * 0.32) {
      used.add(nearestIndex);
      matched++;
    }
    lines.push(Math.round(nearest));
  }
  return matched >= Math.max(5, n - 1) ? lines : null;
}

function gridFitScore(lines: number[], peaks: number[], n: number, size: number): number {
  const step = (lines[n] - lines[0]) / n;
  let matched = 0;
  for (const line of lines) if (peaks.some((p) => Math.abs(p - line) < step * 0.32)) matched++;
  return matched / (n + 1) + Math.min(0.25, (lines[n] - lines[0]) / size / 4);
}

// ---------------------------------------------------------------------------
// Stage 4: per-cell sampling
// ---------------------------------------------------------------------------

interface CellSample {
  r: number;
  c: number;
  rgb: RGB;
  lab: Lab;
  bgL: number;
  whiteFrac: number;
  darkFrac: number;
  diagWhiteD1: number;
  diagWhiteD2: number;
  plainWhite: number;
  brightFrac: number;
  d1Bright: number;
  d2Bright: number;
  plainBright: number;
}

function sampleCells(rgba: Uint8ClampedArray, size: number, v: number[], h: number[], n: number): CellSample[] {
  const cells: CellSample[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      cells.push(sampleOneCell(rgba, size, v[c], v[c + 1], h[r], h[r + 1], r, c));
    }
  }
  return cells;
}

function sampleOneCell(
  rgba: Uint8ClampedArray,
  size: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  r: number,
  c: number,
): CellSample {
  const cw = Math.max(4, x1 - x0);
  const ch = Math.max(4, y1 - y0);
  const ix0 = Math.round(x0 + cw * 0.24);
  const ix1 = Math.round(x1 - cw * 0.24);
  const iy0 = Math.round(y0 + ch * 0.24);
  const iy1 = Math.round(y1 - ch * 0.24);
  const cx = (ix0 + ix1) / 2;
  const cy = (iy0 + iy1) / 2;
  const half = Math.min(ix1 - ix0, iy1 - iy0) / 2 || 1;

  const ringR: number[] = [];
  const ringG: number[] = [];
  const ringB: number[] = [];
  let white = 0;
  let dark = 0;
  let total = 0;
  let diagW1 = 0;
  let diagT1 = 0;
  let diagW2 = 0;
  let diagT2 = 0;
  let plainW = 0;
  let plainT = 0;
  let bright1 = 0;
  let bright2 = 0;
  let plainB = 0;
  let brightCount = 0;
  const Ls: number[] = [];
  const bands: number[] = [];
  const ring = 3;

  for (let y = iy0; y <= iy1; y++) {
    for (let x = ix0; x <= ix1; x++) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const o = (y * size + x) * 4;
      const R = rgba[o];
      const G = rgba[o + 1];
      const B = rgba[o + 2];
      const L = 0.299 * R + 0.587 * G + 0.114 * B;
      Ls.push(L);
      total++;
      const isWhite = R > 165 && G > 165 && B > 165 && Math.max(R, G, B) - Math.min(R, G, B) < 60;
      const isDark = L < 110;
      if (isWhite) white++;
      if (isDark) dark++;
      const dx = (x - cx) / half;
      const dy = (y - cy) / half;
      const onD1 = Math.abs(dx - dy) < 0.3 && Math.abs(dx) < 0.95;
      const onD2 = Math.abs(dx + dy) < 0.3 && Math.abs(dx) < 0.95;
      const onDiag = onD1 || onD2;
      if (onD1) {
        diagT1++;
        if (isWhite) diagW1++;
      } else if (onD2) {
        diagT2++;
        if (isWhite) diagW2++;
      } else if (Math.abs(dx) < 0.6 && Math.abs(dy) < 0.6) {
        plainT++;
        if (isWhite) plainW++;
      }
      bands.push(onD1 && !onD2 ? 1 : onD2 && !onD1 ? 2 : !onDiag && Math.abs(dx) < 0.6 && Math.abs(dy) < 0.6 ? 0 : -1);
      const onRing = x - ix0 < ring || ix1 - x < ring || y - iy0 < ring || iy1 - y < ring;
      if (onRing && !isSlate(R, G, B)) {
        ringR.push(R);
        ringG.push(G);
        ringB.push(B);
      }
    }
  }
  const rgb: RGB = [
    ringR.length ? median(ringR) : 128,
    ringG.length ? median(ringG) : 128,
    ringB.length ? median(ringB) : 128,
  ];
  const bgL = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  // bg-relative bright pass
  for (let i = 0; i < Ls.length; i++) {
    const isBright = Ls[i] - bgL > 28;
    if (isBright) brightCount++;
    if (bands[i] === 1) {
      if (isBright) bright1++;
    } else if (bands[i] === 2) {
      if (isBright) bright2++;
    } else if (bands[i] === 0) {
      if (isBright) plainB++;
    }
  }
  return {
    r,
    c,
    rgb,
    lab: rgbToLab(rgb[0], rgb[1], rgb[2]),
    bgL,
    whiteFrac: total ? white / total : 0,
    darkFrac: total ? dark / total : 0,
    diagWhiteD1: diagT1 ? diagW1 / diagT1 : 0,
    diagWhiteD2: diagT2 ? diagW2 / diagT2 : 0,
    plainWhite: plainT ? plainW / plainT : 0,
    brightFrac: Ls.length ? brightCount / Ls.length : 0,
    d1Bright: diagT1 ? bright1 / diagT1 : 0,
    d2Bright: diagT2 ? bright2 / diagT2 : 0,
    plainBright: plainT ? plainB / plainT : 0,
  };
}

function isSlate(r: number, g: number, b: number): boolean {
  // Slate-grey frame/grid colour. Keep this deliberately loose: JPEG
  // compression, screen capture scaling, and phone white balance all move
  // the grid away from its nominal blue-grey colour.
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const sat = mx - mn;
  const L = 0.299 * r + 0.587 * g + 0.114 * b;
  return sat < 72 && L > 30 && L < 205 && b >= r - 22 && g >= r - 22;
}

// ---------------------------------------------------------------------------
// Stage 5: classify X marks and pre-placed crowns
// ---------------------------------------------------------------------------

interface MarkResult {
  kind: ("empty" | "x" | "crown")[];
  xCount: number;
  crownCount: number;
  conf: number[];
}

function classifyMarks(cells: CellSample[]): MarkResult {
  // We need per-cell dark and bright coverage. The crown icon (dodoco) is a
  // dark ring with white face inside, so it has both dark and white. An X
  // mark is two thin white diagonals on the cell background (no dark ink).
  // The cell background itself can be quite light (pastel), so we use
  // bg-relative brightness, not absolute.
  const darks = cells.map((c) => c.darkFrac);
  let otsuD = 0.04;
  if (darks.length >= 4) {
    const s = darks.slice().sort((a, b) => a - b);
    let best = 0;
    let bestT = s[Math.floor(s.length / 2)];
    for (let i = 1; i < s.length - 1; i++) {
      const t = (s[i] + s[i + 1]) / 2;
      const left = s.slice(0, i + 1);
      const right = s.slice(i + 1);
      const mL = left.reduce((a, b) => a + b, 0) / left.length;
      const mR = right.reduce((a, b) => a + b, 0) / right.length;
      const vL = left.reduce((a, b) => a + (b - mL) ** 2, 0) / left.length;
      const vR = right.reduce((a, b) => a + (b - mR) ** 2, 0) / right.length;
      const wL = left.length / s.length;
      const wR = right.length / s.length;
      const between = wL * wR * (mL - mR) ** 2;
      const within = wL * vL + wR * vR + 1e-9;
      const score = between / within;
      if (score > best) {
        best = score;
        bestT = t;
      }
    }
    otsuD = bestT;
  }
  const iconThr = Math.min(0.075, Math.max(0.028, otsuD));
  const kind: ("empty" | "x" | "crown")[] = [];
  const conf: number[] = [];
  let xCount = 0;
  let crownCount = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const iconScore = c.darkFrac;
    if (iconScore >= iconThr && c.darkFrac >= 0.025 && c.brightFrac >= 0.05 && c.brightFrac <= 0.7) {
      kind.push("crown");
      conf.push(Math.min(1, iconScore / 0.12));
      crownCount++;
      continue;
    }
    const strokes = Math.min(c.diagWhiteD1, c.diagWhiteD2);
    const strokeAvg = (c.diagWhiteD1 + c.diagWhiteD2) / 2;
    const isX =
      strokes >= 0.1 &&
      strokeAvg > c.plainWhite + 0.04 &&
      c.plainWhite <= 0.4 &&
      c.brightFrac >= 0.02 &&
      c.brightFrac <= 0.6 &&
      c.darkFrac < 0.05;
    if (isX) {
      kind.push("x");
      conf.push(Math.min(1, strokes / 0.45));
      xCount++;
    } else {
      kind.push("empty");
      conf.push(Math.min(1, Math.max(0.05, 1 - strokeAvg * 2 - iconScore * 8)));
    }
  }
  return { kind, xCount, crownCount, conf };
}

// ---------------------------------------------------------------------------
// Stage 6: region clustering (OpenCV kmeans + connectivity repair)
// ---------------------------------------------------------------------------

interface ClusterResult {
  assign: number[];
  centers: Lab[];
}

function clusterRegions(cells: CellSample[], n: number): ClusterResult | null {
  const cv = getOpenCV();
  // Build the per-cell Lab samples (1 row per cell, 3 cols of float32).
  const samples = new cv.Mat(cells.length, 3, cv.CV_32F);
  for (let i = 0; i < cells.length; i++) {
    samples.data32F[i * 3] = cells[i].lab[0];
    samples.data32F[i * 3 + 1] = cells[i].lab[1];
    samples.data32F[i * 3 + 2] = cells[i].lab[2];
  }
  const labels = new cv.Mat();
  const centers = new cv.Mat();
  const criteria = new cv.TermCriteria(TERM_CRITERIA_EPS + TERM_CRITERIA_MAX_ITER, 25, 1.0);
  try {
    cv.kmeans(samples, n, labels, criteria, 6, KMEANS_PP_CENTERS, centers);
  } catch {
    samples.delete();
    labels.delete();
    centers.delete();
    return null;
  }
  const assign: number[] = new Array(cells.length);
  for (let i = 0; i < cells.length; i++) assign[i] = labels.data32S[i];
  const centerArr: Lab[] = [];
  for (let k = 0; k < n; k++) {
    centerArr.push([centers.data32F[k * 3], centers.data32F[k * 3 + 1], centers.data32F[k * 3 + 2]]);
  }
  samples.delete();
  labels.delete();
  centers.delete();

  // Connectivity repair: 4-connected flood-fill per label, merge the smaller
  // components into their nearest different-labelled neighbour. This is
  // essential for block-style region maps (image6.jpg) where two same-
  // coloured regions touch diagonally.
  const compOf = new Array<number>(cells.length).fill(-1);
  const comps: number[][] = [];
  for (let i = 0; i < cells.length; i++) {
    if (compOf[i] !== -1) continue;
    const region = assign[i];
    const queue = [i];
    compOf[i] = comps.length;
    const members: number[] = [i];
    while (queue.length) {
      const p = queue.pop()!;
      const pr = (p / n) | 0;
      const pc = p % n;
      const nbs: number[] = [];
      if (pr > 0) nbs.push(p - n);
      if (pr + 1 < n) nbs.push(p + n);
      if (pc > 0) nbs.push(p - 1);
      if (pc + 1 < n) nbs.push(p + 1);
      for (const m of nbs) {
        if (compOf[m] === -1 && assign[m] === region) {
          compOf[m] = comps.length;
          members.push(m);
          queue.push(m);
        }
      }
    }
    comps.push(members);
  }
  const byRegion = new Map<number, number[]>();
  comps.forEach((members, ci) => {
    const r = assign[members[0]];
    if (!byRegion.has(r)) byRegion.set(r, []);
    byRegion.get(r)!.push(ci);
  });
  for (const [, compList] of byRegion) {
    if (compList.length <= 1) continue;
    compList.sort((a, b) => comps[b].length - comps[a].length);
    for (let k = 1; k < compList.length; k++) {
      for (const m of comps[compList[k]]) {
        const pr = (m / n) | 0;
        const pc = m % n;
        let bi = assign[m];
        let bd = Infinity;
        const tryN = (rr: number, cc: number): void => {
          if (rr < 0 || cc < 0 || rr >= n || cc >= n) return;
          const j = rr * n + cc;
          const reg = assign[j];
          if (reg === assign[m]) return;
          const d = labDist(cells[m].lab, centerArr[reg]);
          if (d < bd) {
            bd = d;
            bi = reg;
          }
        };
        tryN(pr - 1, pc);
        tryN(pr + 1, pc);
        tryN(pr, pc - 1);
        tryN(pr, pc + 1);
        assign[m] = bi;
      }
    }
  }
  // Remap to dense 0..n-1 in order of first occurrence for a stable output.
  const seen = new Map<number, number>();
  const remap = new Array<number>(n);
  let next = 0;
  for (let i = 0; i < cells.length; i++) {
    if (!seen.has(assign[i])) {
      seen.set(assign[i], next);
      remap[assign[i]] = next++;
    }
  }
  for (let i = 0; i < cells.length; i++) assign[i] = remap[assign[i]];
  const finalCenters: Lab[] = new Array(n);
  for (let k = 0; k < n; k++) finalCenters[remap[k]] = centerArr[k];
  if (new Set(assign).size !== n) return null;
  return { assign, centers: finalCenters };
}

// ---------------------------------------------------------------------------
// Async bootstrap helper for the browser pipeline
// ---------------------------------------------------------------------------

/** Ensure the OpenCV runtime is initialised. Safe to call multiple times. */
export async function ensureOpenCV(): Promise<void> {
  await loadOpenCV();
}
