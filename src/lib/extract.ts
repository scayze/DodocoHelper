import type { PuzzleInput } from "../core/types.js";

export interface ExtractResult {
  ok: boolean;
  error: string | null;
  puzzle: PuzzleInput | null;
}

/** The 12 game region colors as [r,g,b]. */
const PALETTE_RGB: Array<[number, number, number]> = [
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

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

function classifyPixel(r: number, g: number, b: number): number {
  let best = -1;
  let bd = Infinity;
  for (let k = 0; k < PALETTE_RGB.length; k++) {
    const d =
      (r - PALETTE_RGB[k][0]) ** 2 +
      (g - PALETTE_RGB[k][1]) ** 2 +
      (b - PALETTE_RGB[k][2]) ** 2;
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  if (bd <= 46 * 46) return best;
  return -1;
}

// ---------------------------------------------------------------------------
// Projection / grid detection
// ---------------------------------------------------------------------------

function smoothArray(a: Float64Array, k: number): Float64Array {
  const n = a.length;
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    let c = 0;
    for (let d = -k; d <= k; d++) {
      const j = i + d;
      if (j >= 0 && j < n) {
        acc += a[j];
        c++;
      }
    }
    s[i] = c ? acc / c : 0;
  }
  return s;
}

function modePeriod(centers: number[]): number {
  const buckets = new Map<number, number>();
  for (let i = 1; i < centers.length; i++) {
    const k = Math.round((centers[i] - centers[i - 1]) / 5) * 5;
    buckets.set(k, (buckets.get(k) ?? 0) + 1);
  }
  let P = 0;
  let pc = 0;
  for (const [b, c] of buckets) if (c > pc) {
    pc = c;
    P = b;
  }
  return P;
}

function localMax(a: Float64Array, guess: number, win: number): number {
  let cm = Math.max(0, Math.min(a.length - 1, guess));
  let bv = -1;
  for (let d = -win; d <= win; d++) {
    const x = guess + d;
    if (x < 0 || x >= a.length) continue;
    if (a[x] > bv) {
      bv = a[x];
      cm = x;
    }
  }
  return cm;
}

/** Perfectly-even lattice across the board extent, snapped to projection peaks. */
function evenLattice(pr: Float64Array, N: number): number[] | null {
  const s = smoothArray(pr, 6);
  const mx = Math.max(...s);
  if (mx <= 0) return null;
  let lo = -1;
  let hi = -1;
  let best = 0;
  let cur = -1;
  for (let i = 0; i <= s.length; i++) {
    const above = i < s.length && s[i] > 0.12 * mx;
    if (above && cur < 0) cur = i;
    if (!above && cur >= 0) {
      if (i - cur > best) {
        best = i - cur;
        lo = cur;
        hi = i - 1;
      }
      cur = -1;
    }
  }
  if (lo < 0) {
    lo = 0;
    hi = s.length - 1;
  }
  const span = hi - lo;
  const step = span / N;
  const out: number[] = [];
  const win = Math.max(3, Math.round(step * 0.35));
  for (let k = 0; k < N; k++) {
    out.push(localMax(pr, Math.round(lo + step * (k + 0.5)), win));
  }
  return out;
}

/** Autocorrelation: first strong local-max lag = the grid period (cell pitch). */
function autocorrPeriod(s: Float64Array): number {
  const n = s.length;
  const maxLag = Math.min(300, Math.floor(n / 2));
  const scores: Array<{ lag: number; v: number }> = [];
  for (let lag = 25; lag <= maxLag; lag++) {
    let c = 0;
    let m = 0;
    for (let i = 0; i <= n - 1 - lag; i++) {
      c += s[i] * s[i + lag];
      m += s[i] * s[i];
    }
    scores.push({ lag, v: m ? c / m : 0 });
  }
  for (let i = 1; i < scores.length - 1; i++) {
    if (scores[i].v > scores[i - 1].v && scores[i].v >= scores[i + 1].v && scores[i].v > 0.3) {
      return scores[i].lag;
    }
  }
  return 0;
}

interface GridInfo {
  centers: number[];
  step: number;
}

function gridRunBased(pr: Float64Array): GridInfo | null {
  const s = smoothArray(pr, 6);
  const mx = Math.max(...s);
  if (mx <= 0) return null;
  for (const thrf of [0.32, 0.36, 0.4]) {
    const thr = mx * thrf;
    const runs: Array<[number, number]> = [];
    let inRun = false;
    let rs = 0;
    for (let x = 0; x <= s.length; x++) {
      const hi = x < s.length && s[x] > thr;
      if (hi && !inRun) {
        inRun = true;
        rs = x;
      }
      if (!hi && inRun) {
        inRun = false;
        runs.push([rs, x - 1]);
      }
    }
    if (runs.length < 7) continue;
    const widths = runs.map(([a, b]) => b - a + 1).sort((x, y) => x - y);
    const med = widths[Math.floor(widths.length / 2)] || 1;
    const filtered = runs.filter(([a, b]) => {
      const w = b - a + 1;
      return w >= Math.max(3, med * 0.4) && w <= med * 1.75;
    });
    if (filtered.length < 7) continue;
    const centers = filtered.map(([a, b]) => Math.round((a + b) / 2)).sort((x, y) => x - y);
    let P = modePeriod(centers);
    if (!P) continue;
    let best: { i: number; j: number; len: number } | null = null;
    for (let i = 0; i < centers.length; i++) {
      let j = i;
      while (j + 1 < centers.length) {
        const g = centers[j + 1] - centers[j];
        if (g >= 0.55 * P && g <= 1.5 * P) j++;
        else break;
      }
      const len = j - i + 1;
      if (!best || len > best.len) best = { i, j, len };
    }
    if (!best) continue;
    const sub = centers.slice(best.i, best.j + 1);
    const P2 = modePeriod(sub);
    if (sub.length < 7 || sub.length > 12) continue;
    return { centers: sub.map((c0) => localMax(s, c0, Math.round(P2 * 0.4))), step: P2 };
  }
  return null;
}

/**
 * Find a perfectly-even N-cell lattice along an axis with pitch P.
 *
 * First the board's extent is estimated as the N*P-tall window holding the
 * most palette density. Offsets are then searched only within that window, so
 * non-board content (denser header/footer) cannot lure the lattice off the
 * board. The winning offset places every lattice point on a dense cell row.
 */
function latticeOffset(pr: Float64Array, N: number, P: number): GridInfo | null {
  if (N < 7 || N > 12 || P < 20) return null;
  const len = pr.length;
  const winH = N * P;
  if (len < winH + 1) return null;
  // Best N*P-tall window (highest palette density).
  const cum = new Float64Array(len + 1);
  for (let i = 0; i < len; i++) cum[i + 1] = cum[i] + pr[i];
  let bestStart = 0;
  let bestTotal = -1;
  for (let st = 0; st <= len - winH; st++) {
    const v = cum[st + winH] - cum[st];
    if (v > bestTotal) {
      bestTotal = v;
      bestStart = st;
    }
  }
  // Score offsets over a widened range around the window, on the RAW
  // projection so exact row-centers win (smoothing blurs adjacent peaks).
  const lo = Math.max(0, bestStart - Math.round(P * 0.5));
  const hi = Math.min(len - 1 - (N - 1) * P, bestStart + Math.round(P * 1.5));
  let bestO = lo;
  let bestScore = -Infinity;
  for (let o = lo; o <= hi; o++) {
    let score = 0;
    for (let k = 0; k < N; k++) score += pr[o + k * P];
    if (score > bestScore) {
      bestScore = score;
      bestO = o;
    }
  }
  // Exact even lattice: cell cores are dense across their whole width, so a
  // wide local-max snap can jump onto an adjacent within-cell spurious peak.
  // Use the perfectly-even positions directly.
  const centers: number[] = [];
  for (let k = 0; k < N; k++) centers.push(bestO + k * P);
  return { centers, step: P };
}

function gridFromProjection(pr: Float64Array): GridInfo | null {
  const rb = gridRunBased(pr);
  if (rb) return rb;
  // extent fallback
  const s = smoothArray(pr, 6);
  const mx = Math.max(...s);
  const P = autocorrPeriod(s);
  if (!P || mx <= 0) return null;
  let lo = -1;
  let hi = -1;
  let best = 0;
  let cur = -1;
  for (let i = 0; i <= s.length; i++) {
    const above = i < s.length && s[i] > 0.12 * mx;
    if (above && cur < 0) cur = i;
    if (!above && cur >= 0) {
      if (i - cur > best) {
        best = i - cur;
        lo = cur;
        hi = i - 1;
      }
      cur = -1;
    }
  }
  if (lo < 0) return null;
  let N = Math.round((hi - lo + 1) / P);
  if (N < 7 || N > 12) N = Math.max(7, Math.min(12, N));
  let a = lo;
  let am = -1;
  for (let i = lo; i <= hi; i++) if (s[i] > am) {
    am = s[i];
    a = i;
  }
  const centers: number[] = [];
  for (let k = Math.ceil((lo - a) / P); k <= Math.floor((hi - a) / P); k++) {
    const c0 = a + k * P;
    const c = localMax(pr, c0, Math.round(P * 0.42));
    if (s[c] > 0.2 * mx) centers.push(c);
  }
  const uniq = [...new Set(centers)].sort((x, y) => x - y);
  if (uniq.length < 7 || uniq.length > 12) return null;
  return { centers: uniq, step: P };
}

// ---------------------------------------------------------------------------
// Cell sampling
// ---------------------------------------------------------------------------

function regionId(mask: Int8Array, w: number, h: number, cx: number, cy: number, cell: number): number {
  const votes = new Array(PALETTE_RGB.length).fill(0);
  const half = Math.max(2, Math.round(cell * 0.28));
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const y = cy + dy;
      const x = cx + dx;
      if (y < 0 || y >= h || x < 0 || x >= w) continue;
      const v = mask[y * w + x];
      if (v >= 0) votes[v]++;
    }
  }
  let bi = 0;
  for (let i = 1; i < votes.length; i++) if (votes[i] > votes[bi]) bi = i;
  return votes[bi] > 0 ? bi : -1;
}

/**
 * Detect the marking in a cell using a strict white-mask scan.
 *   - True white mark pixels = bright AND near-neutral (this rules out light-tinted
 *     region inks such as peach / light-blue, which otherwise false-positive).
 *   - A cell with no such white → no marking ("?").
 *   - A large / dense white icon → crown ("C"); a thin white cross → ".".
 *     Crown icons are the denser black-and-white emblem; crosses are thin strokes.
 */
function detectSymbol(data: Uint8ClampedArray, w: number, h: number, cx: number, cy: number, cell: number): string {
  const half = Math.max(2, Math.round(cell * 0.28));
  let white = 0;
  let tot = 0;
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const y = cy + dy;
      const x = cx + dx;
      if (y < 0 || y >= h || x < 0 || x >= w) continue;
      const o = (y * w + x) * 4;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      tot++;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      if (mx > 190 && mx - mn < 30) white++;
    }
  }
  if (!tot) return "?";
  const wf = white / tot;
  if (wf < 0.03) return "?";
  if (wf >= 0.07) return "C";
  return ".";
}

/** Remap distinct region labels to canonical 0..N-1 (in first-appearance order). */
function canonicalize(regions: number[][], N: number): { regions: number[][]; palette: string[] } {
  const map = new Map<number, number>();
  const palette: string[] = [];
  const out = regions.map((row) =>
    row.map((v) => {
      if (v < 0) return 0;
      let id = map.get(v);
      if (id === undefined) {
        id = palette.length;
        map.set(v, id);
        const c = PALETTE_RGB[v];
        const hex = ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1);
        palette.push("#" + hex.toUpperCase());
      }
      return id;
    }),
  );
  // if we didn't get N distinct labels (some cell straddled an edge), duplicate to pad
  while (palette.length < N) {
    const c = PALETTE_RGB[palette.length % PALETTE_RGB.length];
    palette.push("#" + ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1).toUpperCase());
  }
  return { regions: out, palette };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Downscaling (area-average box filter for large images)
// ---------------------------------------------------------------------------

interface ScaledImage {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

/** Downscale RGBA pixels with an area-average box filter so the longest side fits within `max`. */
function downscaleBox(data: Uint8ClampedArray, w: number, h: number, max: number): ScaledImage {
  const w2 = Math.max(1, Math.round((w * max) / Math.max(w, h)));
  const h2 = Math.max(1, Math.round((h * max) / Math.max(w, h)));
  const out = new Uint8ClampedArray(w2 * h2 * 4);
  const sx = w / w2;
  const sy = h / h2;
  for (let y = 0; y < h2; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(h, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < w2; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(w, Math.ceil((x + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * w + xx) * 4;
          r += data[o];
          g += data[o + 1];
          b += data[o + 2];
          a += data[o + 3];
          n++;
        }
      }
      const o2 = (y * w2 + x) * 4;
      out[o2] = Math.round(r / n);
      out[o2 + 1] = Math.round(g / n);
      out[o2 + 2] = Math.round(b / n);
      out[o2 + 3] = Math.round(a / n);
    }
  }
  return { data: out, w: w2, h: h2 };
}

/**
 * Extract a puzzle board from raw RGBA pixels. Shared by the browser and the
 * Node test harness so both exercise the exact same pipeline.
 */
export async function extractBoardFromRGBA(data: Uint8ClampedArray, w: number, h: number): Promise<PuzzleInput | null> {
  const MAX = 1600;
  if (Math.max(w, h) <= MAX) {
    return analyze(data, w, h);
  }
  // Downscale large images before analysis.
  const small = downscaleBox(data, w, h, MAX);
  return analyze(small.data, small.w, small.h);
}

/** Pure analysis on RGBA pixels (already scaled). Returns PuzzleInput or null. */
export function analyze(data: Uint8ClampedArray, w: number, h: number): PuzzleInput | null {
  const mask = new Int8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    mask[i] = classifyPixel(data[o], data[o + 1], data[o + 2]);
  }
  const cp = new Float64Array(w);
  const rp = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] >= 0) {
        cp[x]++;
        rp[y]++;
      }
    }
  }
  let cols = gridFromProjection(cp);
  let rows = gridFromProjection(rp);
  if (!cols || !rows) return null;
  let didRefit = false;
  if (cols.centers.length !== rows.centers.length) {
    // Prefer the axis that yielded a clean square count; force the other onto
    // the same N/pitch with a density-maximizing lattice (robust to
    // header/footer contamination like image56).
    const P = Math.max(20, cols.step);
    if (cols.centers.length >= 7 && cols.centers.length <= 12) {
      rows = latticeOffset(rp, cols.centers.length, P);
      didRefit = true;
    } else if (rows.centers.length >= 7 && rows.centers.length <= 12) {
      cols = latticeOffset(cp, rows.centers.length, P);
      didRefit = true;
    }
    if (rows && cols && rows.centers.length !== cols.centers.length) rows = null;
  }
  // The board is square: if a lattice refit happened, both axes must share the
  // same centers. Unify them onto the autocorrelation-derived pitch so cells
  // line up exactly. (gridRunBased's step can be a couple px off on noisy both
  // axes, which misaligns the last row/column.)
  if (didRefit && rows && cols && rows.centers.length === cols.centers.length) {
    const P = autocorrPeriod(smoothArray(rp, 6)) || autocorrPeriod(smoothArray(cp, 6)) || Math.max(20, cols.step);
    const unified = latticeOffset(rp, rows.centers.length, P);
    if (unified && unified.centers.length === rows.centers.length) {
      cols = { centers: unified.centers, step: unified.step };
      rows = { centers: unified.centers, step: unified.step };
    }
  }
  if (!cols || !rows || cols.centers.length !== rows.centers.length) return null;
  const N = cols.centers.length;
  const cell = Math.round(cols.step);
  const step = Math.max(20, cols.step);

  // Build the region grid for the given axes; returns null if it doesn't look
  // like a valid partition: exactly N distinct colors AND each color forms a
  // single 4-connected region (a misregistered board fragments/mixes them).
  const build = (c: GridInfo, r: GridInfo): { regions: number[][] } | null => {
    const raw: number[][] = [];
    for (let ri = 0; ri < N; ri++) {
      const row: number[] = [];
      for (let ci = 0; ci < N; ci++) {
        row.push(regionId(mask, w, h, c.centers[ci], r.centers[ri], cell));
      }
      raw.push(row);
    }
    const flat = raw.flat();
    if (new Set(flat).size !== N) return null;
    // 4-connected component count over same-label cells
    const seen = new Set<number>();
    let comps = 0;
    for (let ri = 0; ri < N; ri++) {
      for (let ci = 0; ci < N; ci++) {
        const idx = ri * N + ci;
        if (seen.has(idx)) continue;
        comps++;
        const label = raw[ri][ci];
        const stack = [idx];
        seen.add(idx);
        while (stack.length) {
          const cur = stack.pop()!;
          const cr = Math.floor(cur / N);
          const cc = cur % N;
          const neighbors: Array<[number, number]> = [
            [cr - 1, cc],
            [cr + 1, cc],
            [cr, cc - 1],
            [cr, cc + 1],
          ];
          for (const [nr, nc] of neighbors) {
            if (nr < 0 || nr >= N || nc < 0 || nc >= N) continue;
            const nIdx = nr * N + nc;
            if (seen.has(nIdx)) continue;
            if (raw[nr][nc] === label) {
              seen.add(nIdx);
              stack.push(nIdx);
            }
          }
        }
      }
    }
    return comps === N ? { regions: raw } : null;
  };

  let best = build(cols, rows);

  // Self-correct: a misregistered board yields an invalid partition; retry each
  // axis with the period-and-extent lattice (recovers genuinely-missing cells),
  // and keep the first configuration that looks like a real board.
  if (!best) {
    // Try lattice-offset fits (both axes and both combinations). These are
    // robust to contamination and to imperfect run-based counts.
    const P = Math.max(20, cols.step);
    const candidates: Array<{ cols: GridInfo; rows: GridInfo }> = [{ cols, rows }];
    const cL = cols.centers.length === N ? latticeOffset(cp, N, P) : null;
    const rL = rows.centers.length === N ? latticeOffset(rp, N, P) : null;
    const cEa = evenLattice(cp, N);
    const rEa = evenLattice(rp, N);
    const cE = cEa ? { centers: cEa, step } : null;
    const rE = rEa ? { centers: rEa, step } : null;
    const pushC = (c: GridInfo | null, r: GridInfo | null) => {
      if (c && r && c.centers.length === N && r.centers.length === N) {
        candidates.push({ cols: c, rows: r });
      }
    };
    pushC(cL, rL);
    pushC(cL, rE);
    pushC(cE, rL);
    pushC(cE, rE);
    for (const cand of candidates) {
      if (cand.cols.centers.length !== N || cand.rows.centers.length !== N) continue;
      const built = build(cand.cols, cand.rows);
      if (built) {
        best = built;
        cols = cand.cols;
        rows = cand.rows;
        break;
      }
    }
  }
  if (!best) return null;

  const initial: string[][] = [];
  for (let r = 0; r < N; r++) {
    const ii: string[] = [];
    for (let c = 0; c < N; c++) {
      ii.push(detectSymbol(data, w, h, cols.centers[c], rows.centers[r], cell));
    }
    initial.push(ii);
  }
  const { regions, palette } = canonicalize(best.regions, N);
  return {
    size: N,
    crownsPerRow: 2,
    crownsPerColumn: 2,
    crownsPerRegion: 2,
    regions,
    initial,
    palette,
  };
}

/**
 * Extract a board from a browser File by decoding it to RGBA first.
 */
export async function extractBoardFromFile(file: File): Promise<ExtractResult> {
  try {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = reject;
        im.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return { ok: false, error: "canvas 2D not supported", puzzle: null };
      ctx.drawImage(img, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const puzzle = await extractBoardFromRGBA(data, width, height);
      if (!puzzle) return { ok: false, error: "could not locate a puzzle grid in that image", puzzle: null };
      return { ok: true, error: null, puzzle };
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? `image decoding failed: ${e.message}` : "image decoding failed",
      puzzle: null,
    };
  }
}

/**
 * Compare two region label grids up to a global relabeling (partition equality).
 * This is the correct notion of "same board" since region ids are arbitrary.
 */
export function relabelMatch(a: number[][], b: number[][]): boolean {
  if (a.length !== b.length) return false;
  const n = a.length;
  const map = new Map<number, number>();
  const ra = new Set<number>();
  const rb = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (a[i].length !== n || b[i].length !== n) return false;
    for (let j = 0; j < n; j++) {
      const va = a[i][j];
      const vb = b[i][j];
      if (map.has(va) && map.get(va) !== vb) return false;
      map.set(va, vb);
      ra.add(va);
      rb.add(vb);
    }
  }
  return map.size === ra.size && map.size === rb.size && ra.size > 0;
}

