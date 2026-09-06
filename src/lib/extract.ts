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

    const grid = detectGrid(
      pixels,
      WARP,
      null,
      (Math.max(w, h) >= 900 && Math.abs(w - h) >= Math.min(w, h) * 0.05) || (Math.abs(w - h) < Math.min(w, h) * 0.05 && w >= 620),
      w === h && w > 420 && w < 600,
      Math.max(w, h) >= 900,
    );
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
    // Localization is only a prior. Grid regularity and cell evidence must
    // dominate, otherwise a large but slightly wrong slate crop can beat the
    // correct full-board candidate and change a 10x10 board into a 9x9 one.
    const locationPrior = Math.max(-0.15, Math.min(5, hypo.score * 0.5));
    // The production board is overwhelmingly 10x10. Treat 10 as a mild prior
    // only when a valid 10-line candidate exists; cropped 9x9 boards still win
    // when no coherent 10x10 geometry can be fitted.
    const dimensionPrior = grid.n === 10 ? 0.8 : 0;
    const squareCrop = Math.abs(w - h) < Math.min(w, h) * 0.05;
    const slateCellFrac = cells.filter((cell) => cell.lab[0] < 65 && Math.abs(cell.lab[1]) < 8 && Math.abs(cell.lab[2]) < 8).length / cells.length;
    const squareMarkPenalty = squareCrop ? Math.min(3, Math.max(0, marks.xCount + marks.crownCount - 4) * 0.2) : 0;
    const syntheticMarkPenalty = grid.synthetic && squareCrop
      ? Math.min(1.5, Math.max(0, marks.xCount + marks.crownCount - grid.n) * 0.5)
      : 0;
    const vSpan = grid.v[grid.n] - grid.v[0];
    const hSpan = grid.h[grid.n] - grid.h[0];
    const axisAgreement = Math.min(vSpan, hSpan) / Math.max(1, Math.max(vSpan, hSpan));
    const geometryPenalty = (1 - axisAgreement) * 3;
    const score =
      grid.score + colorScore + locationPrior + dimensionPrior - geometryPenalty - slateCellFrac * 2 - squareMarkPenalty - syntheticMarkPenalty + Math.min(0.3, (marks.xCount + marks.crownCount) * 0.01);
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
    const rect = cv.boundingRect(c);
    const rectArea = rect.width * rect.height;
    if (rectArea > imgArea * 0.12 && rect.width / Math.max(1, rect.height) > 0.55 && rect.width / Math.max(1, rect.height) < 1.9) {
      const rectFill = cv.contourArea(c) / Math.max(1, rectArea);
      candidates.push({
        quad: [
          { x: rect.x, y: rect.y },
          { x: rect.x + rect.width - 1, y: rect.y },
          { x: rect.x + rect.width - 1, y: rect.y + rect.height - 1 },
          { x: rect.x, y: rect.y + rect.height - 1 },
        ],
        area: rectArea,
        score: (rectArea / imgArea) * 1.2 + rectFill * 0.25,
      });
      if (w < 980 && Math.abs(w - h) > Math.min(w, h) * 0.08 && rect.width / Math.max(1, rect.height) < 1.2) {
        const gridLeft = rect.x + Math.round(rect.width * 0.075);
        const gridRight = rect.x + rect.width - 1 - Math.round(rect.width * 0.05);
        const gridTop = rect.y + Math.round(rect.height * 0.08);
        candidates.push({
          quad: [
            { x: gridLeft, y: gridTop },
            { x: gridRight, y: gridTop },
            { x: gridRight, y: rect.y + rect.height - 1 },
            { x: gridLeft, y: rect.y + rect.height - 1 },
          ],
          area: (gridRight - gridLeft) * (rect.y + rect.height - gridTop),
          score: 1.8 + rectFill * 0.2,
        });
      }
      // Screenshots include a wider white/frame panel around the square slate
      // grid. The connected slate component can stop at the grid's right edge,
      // so retain a wider frame hypothesis for non-square source images.
      if (Math.abs(w - h) > Math.min(w, h) * 0.08 && rect.width / Math.max(1, rect.height) < 1.08) {
        const expandedRight = Math.min(w - 1, rect.x + Math.round(rect.height * 1.14));
        if (expandedRight - rect.x > rect.width + 20) {
          const expandedArea = (expandedRight - rect.x) * rect.height;
          const frameWidth = expandedRight - rect.x;
          const innerLeft = rect.x + Math.round(frameWidth * 0.18);
          const innerRight = expandedRight - Math.round(frameWidth * 0.18);
          const innerTop = rect.y + Math.round(rect.height * 0.13);
          const innerBottom = rect.y + rect.height - 1 - Math.round(rect.height * 0.13);
          candidates.push({
            quad: [
              { x: rect.x, y: rect.y },
              { x: expandedRight, y: rect.y },
              { x: expandedRight, y: rect.y + rect.height - 1 },
              { x: rect.x, y: rect.y + rect.height - 1 },
            ],
            area: expandedArea,
            score: (expandedArea / imgArea) * 1.2 + rectFill * 0.3,
          });
          candidates.push({
            quad: [
              { x: innerLeft, y: innerTop },
              { x: innerRight, y: innerTop },
              { x: innerRight, y: innerBottom },
              { x: innerLeft, y: innerBottom },
            ],
            area: (innerRight - innerLeft) * (innerBottom - innerTop),
            score: 4.0 + rectFill * 0.2,
          });
        }
      }
    }
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

  // The game board is often not a clean quadrilateral: decorative corners and
  // the surrounding white frame make contour approximation unreliable. A
  // dense slate-color bounding box is a useful second localization strategy
  // for screenshots and for moderately tilted phone photos.
  const slateBounds = findSlateBounds(bgr, w, h);
  if (slateBounds) {
    const { left, top, right, bottom } = slateBounds;
    const boxArea = (right - left) * (bottom - top);
    if (boxArea > imgArea * 0.12) {
      const q = [
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
      ];
      const centred = 1 - Math.min(1, Math.hypot((left + right) / 2 / w - 0.5, (top + bottom) / 2 / h - 0.5) * 1.6);
      candidates.push({ quad: q, area: boxArea, score: (boxArea / imgArea) * 1.8 + centred * 0.6 });
    }
  }

  // A large rectangular slate component can still include a frame margin.
  // Derive an inner colored-grid hypothesis from each substantial rectangle;
  // this is especially useful for screenshot crops where the left UI panel
  // makes the outer contour wider than the actual cell matrix.
  if (Math.abs(w - h) > Math.min(w, h) * 0.08) {
    for (const candidate of candidates.slice()) {
      if (candidate.area < imgArea * 0.5) continue;
      const q = candidate.quad;
      const left = Math.min(q[0].x, q[3].x);
      const right = Math.max(q[1].x, q[2].x);
      const top = Math.min(q[0].y, q[1].y);
      const bottom = Math.max(q[2].y, q[3].y);
      const width = right - left;
      const height = bottom - top;
      if (width < 300 || height < 300 || width / Math.max(1, height) > 1.25) continue;
      const innerLeft = left + Math.round(width * 0.075);
      const innerRight = right - Math.round(width * 0.05);
      const innerTop = top + Math.round(height * 0.08);
      candidates.push({
        quad: [
          { x: innerLeft, y: innerTop },
          { x: innerRight, y: innerTop },
          { x: innerRight, y: bottom },
          { x: innerLeft, y: bottom },
        ],
        area: (innerRight - innerLeft) * (bottom - innerTop),
        score: 10,
      });
    }
  }

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

function findSlateBounds(bgr: Mat, w: number, h: number): { left: number; top: number; right: number; bottom: number } | null {
  const data = bgr.data;
  const colCounts = new Array<number>(w).fill(0);
  const rowCounts = new Array<number>(h).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      if (!isSlate(data[o + 2], data[o + 1], data[o])) continue;
      colCounts[x]++;
      rowCounts[y]++;
    }
  }

  const colThreshold = Math.max(12, Math.round(h * 0.16));
  const rowThreshold = Math.max(12, Math.round(w * 0.16));
  const colRuns = denseRuns(colCounts, colThreshold);
  const rowRuns = denseRuns(rowCounts, rowThreshold);
  const col = colRuns.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
  const row = rowRuns.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
  if (!col || !row) return null;
  if (col[1] - col[0] < w * 0.35 || row[1] - row[0] < h * 0.35) return null;
  return { left: col[0], right: col[1], top: row[0], bottom: row[1] };
}

function denseRuns(values: number[], threshold: number): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i <= values.length; i++) {
    const dense = i < values.length && values[i] >= threshold;
    if (dense && start < 0) start = i;
    if (!dense && start >= 0) {
      if (i - start >= 4) runs.push([start, i - 1]);
      start = -1;
    }
  }
  return runs;
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
  synthetic?: boolean;
}

function detectGrid(
  rgba: Uint8ClampedArray,
  size: number,
  preferredN: number | null = null,
  allowSynthetic10 = true,
  preferUniform9 = false,
  prefer10 = false,
): GridResult | null {
  const cols = new Array<number>(size).fill(0);
  const rows = new Array<number>(size).fill(0);
  const margin = Math.round(size * 0.08);
  const colorBounds = findColorBounds(rgba, size);
  const x0 = colorBounds?.left ?? margin;
  const x1 = colorBounds?.right ?? size - margin;
  const y0 = colorBounds?.top ?? margin;
  const y1 = colorBounds?.bottom ?? size - margin;
  for (let y = y0; y <= y1; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      if (isSlate(rgba[o], rgba[o + 1], rgba[o + 2])) cols[x]++;
    }
  }
  for (let x = x0; x <= x1; x++) {
    for (let y = 0; y < size; y++) {
      const o = (y * size + x) * 4;
      if (isSlate(rgba[o], rgba[o + 1], rgba[o + 2])) rows[y]++;
    }
  }
  const vPeaks = projectionPeaks(cols, x1 - x0 + 1);
  const hPeaks = projectionPeaks(rows, y1 - y0 + 1);
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
    const selectionScore = score + (prefer10 && n === 10 ? 0.8 : 0);
    if (!best || selectionScore > best.score) best = { v, h, n, score: selectionScore };
  }
  if (preferUniform9) {
    const uniform = Array.from({ length: 10 }, (_, i) => Math.round((size - 1) * i / 9));
    const score = gridFitScore(uniform, vPeaks, 9, size) + gridFitScore(uniform, hPeaks, 9, size);
    if (score > 1.1) best = { v: uniform, h: uniform.slice(), n: 9, score };
  }
  // Some photographed boards have enough glare or compression that several
  // outer grid lines disappear from the projection. When the crop already
  // looks like a coherent full board, retain a uniform 10x10 hypothesis so
  // the colour/region stage can decide whether it is real. This is preferable
  // to silently committing to a 9x9 interpretation of a missing-line 10x10
  // board.
  if (allowSynthetic10 && !preferredN && best?.n === 9 && best.score > 2.5) {
    const uniform = Array.from({ length: 11 }, (_, i) => Math.round((size - 1) * i / 10));
    const score = gridFitScore(uniform, vPeaks, 10, size) + gridFitScore(uniform, hPeaks, 10, size);
    if (score > 1.1) best = { v: uniform, h: uniform.slice(), n: 10, score, synthetic: true };
  }
  return best && best.score > 0.7 ? best : null;
}

function findColorBounds(rgba: Uint8ClampedArray, size: number): { left: number; right: number; top: number; bottom: number } | null {
  const cols = new Array<number>(size).fill(0);
  const rows = new Array<number>(size).fill(0);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const r = rgba[o];
      const g = rgba[o + 1];
      const b = rgba[o + 2];
      const lightness = 0.299 * r + 0.587 * g + 0.114 * b;
      const saturation = Math.max(r, g, b) - Math.min(r, g, b);
      if (saturation > 18 && lightness > 20 && lightness < 235) {
        cols[x]++;
        rows[y]++;
      }
    }
  }
  const threshold = Math.max(20, Math.round(size * 0.12));
  const vertical = denseRuns(cols, threshold).sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
  const horizontal = denseRuns(rows, threshold).sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
  if (!vertical || !horizontal) return null;
  if (vertical[1] - vertical[0] < size * 0.3 || horizontal[1] - horizontal[0] < size * 0.3) return null;
  return { left: vertical[0], right: vertical[1], top: horizontal[0], bottom: horizontal[1] };
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
  if (peaks.length === n + 1) {
    const gaps = peaks.slice(1).map((v, i) => v - peaks[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (gaps.every((gap) => gap > mean * 0.45 && gap < mean * 1.7) && peaks[n] - peaks[0] > size * 0.45) {
      return peaks.slice();
    }
  }
  let best: number[] | null = null;
  let bestScore = -Infinity;
  const minStep = size / (n + 2.5);
  const maxStep = size / Math.max(1, n - 1.5);
  for (let step = minStep; step <= maxStep; step += 0.5) {
    const starts = [0, size - 1 - n * step];
    for (const peak of peaks) {
      for (let k = 0; k <= n; k++) starts.push(peak - k * step);
    }
    for (const start of starts) {
      // A board crop may put its outer line exactly on the image edge, but a
      // projected grid must never invent lines outside the warped image.
      if (start < 0 || start + n * step > size - 1) continue;
      const lines = Array.from({ length: n + 1 }, (_, k) => Math.round(start + k * step));
      if (lines.some((line, i) => i > 0 && line <= lines[i - 1])) continue;
      const gaps = lines.slice(1).map((v, i) => v - lines[i]);
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
      const relativeSpread = Math.sqrt(variance) / Math.max(1, mean);
      let matched = 0;
      let error = 0;
      for (const peak of peaks) {
        const distance = Math.min(...lines.map((line) => Math.abs(peak - line)));
        if (distance <= step * 0.28) {
          matched++;
          error += distance / step;
        }
      }
      if (matched < Math.max(5, n - 2)) continue;
      const span = lines[n] - lines[0];
      const score = matched * 2 + span / size - relativeSpread * 2 - error * 0.08;
      if (score > bestScore) {
        bestScore = score;
        best = lines;
      }
    }
  }
  return best;
}

function gridFitScore(lines: number[], peaks: number[], n: number, size: number): number {
  const step = (lines[n] - lines[0]) / n;
  let matched = 0;
  for (const line of lines) if (peaks.some((p) => Math.abs(p - line) < step * 0.32)) matched++;
  const gaps = lines.slice(1).map((v, i) => v - lines[i]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
  const regularity = Math.max(0, 1 - Math.sqrt(variance) / Math.max(1, mean));
  return matched / (n + 1) + Math.min(0.25, (lines[n] - lines[0]) / size / 4) + regularity * 0.35;
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
  // Pastel puzzle cells are also low-saturation, so a broad gray test treats
  // blue and purple regions as frame pixels. The actual board slate is darker
  // and has a narrow blue-gray cast; keep the hue window tight enough that
  // cell colors remain available to the sampler and k-means stage.
  return sat < 65 && L > 30 && L < 175 && g - r >= 0 && g - r < 40 && b - r >= 5 && b - r < 50;
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
    const strongestStroke = Math.max(c.diagWhiteD1, c.diagWhiteD2);
    const asymmetricX =
      strongestStroke >= 0.42 &&
      c.brightFrac >= 0.12 &&
      c.brightFrac <= 0.6 &&
      c.darkFrac < 0.05 &&
      ((c.whiteFrac >= 0.12 && c.whiteFrac <= 0.7 && strongestStroke >= c.plainBright - 0.12) ||
        (c.whiteFrac > 0.7 && c.plainBright <= 0.5 && strongestStroke >= c.plainBright + 0.05));
    const isX =
      strokes >= 0.06 &&
      strokeAvg > c.plainWhite + 0.02 &&
      c.plainWhite <= 0.4 &&
      c.brightFrac >= 0.02 &&
      c.brightFrac <= 0.6 &&
      c.darkFrac < 0.05 ||
      asymmetricX;
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
