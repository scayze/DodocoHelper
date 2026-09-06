// Dev-only fixture harness: decodes test_fixtures images in Node and runs the
// DOM-free extraction pipeline + solver on each. Not part of the test suite.
// Usage: npm run fixtures [-- <file>...]
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "pngjs";
const { PNG } = pkg;
import jpeg from "jpeg-js";
import { debugExtract, ensureOpenCV } from "../dist/src/lib/extract.js";
import { solvePuzzle } from "../dist/src/core/solver.js";

await ensureOpenCV();

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "test_fixtures");
const only = new Set(process.argv.slice(2));

function decode(name) {
  const buf = readFileSync(join(dir, name));
  if (name.endsWith(".png")) {
    const p = PNG.sync.read(buf);
    return { data: new Uint8ClampedArray(p.data), w: p.width, h: p.height };
  }
  const j = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512 });
  return { data: new Uint8ClampedArray(j.data), w: j.width, h: j.height };
}

/** Bilinear downscale to maxSide (mimics browser drawImage cap). */
function capMaxSide(img, maxSide) {
  const s = Math.min(1, maxSide / Math.max(img.w, img.h));
  if (s >= 1) return img;
  const w = Math.max(8, Math.round(img.w * s));
  const h = Math.max(8, Math.round(img.h * s));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = (x + 0.5) / s - 0.5;
      const sy = (y + 0.5) / s - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const y0 = Math.max(0, Math.floor(sy));
      const x1 = Math.min(img.w - 1, x0 + 1);
      const y1 = Math.min(img.h - 1, y0 + 1);
      const fx = Math.min(1, Math.max(0, sx - x0));
      const fy = Math.min(1, Math.max(0, sy - y0));
      const o = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) {
        const a = img.data[(y0 * img.w + x0) * 4 + k];
        const b = img.data[(y0 * img.w + x1) * 4 + k];
        const c = img.data[(y1 * img.w + x0) * 4 + k];
        const d = img.data[(y1 * img.w + x1) * 4 + k];
        out[o + k] = Math.round(a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy);
      }
    }
  }
  return { data: out, w, h };
}

const GLYPHS = "0123456789ABCDEF";

for (const name of readdirSync(dir).sort()) {
  if (!/\.(png|jpg|jpeg)$/i.test(name)) continue;
  if (only.size && ![...only].some((o) => name.includes(o))) continue;
  const raw = decode(name);
  const img = capMaxSide(raw, 1000);
  const t0 = Date.now();
  const { result, debug } = debugExtract(img.data, img.w, img.h);
  const ms = Date.now() - t0;
  console.log(`=== ${name} (${raw.w}x${raw.h} -> ${img.w}x${img.h}) ${ms}ms`);
  for (let i = 0; i < debug.hypos.length; i++) {
    const h = debug.hypos[i];
    const q = h.quad.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(" ");
    console.log(
      `  hypo${i} area=${Math.round(h.area)} strict=${h.strict} quad=[${q}] ` +
        (h.grid
          ? `n=${h.grid.n} lines=${h.grid.v.length}/${h.grid.h.length} gscore=${h.grid.score.toFixed(2)} clusters=${h.clusterCount} x=${h.xCount} c=${h.crownCount} score=${h.score?.toFixed(2)}`
          : `GRID-FAIL: ${h.gridError}`),
    );
  }
  if (debug.best) {
    console.log(`  vlines=[${debug.best.v.join(",")}]`);
    console.log(`  hlines=[${debug.best.h.join(",")}]`);
  }
  if (!result.ok || !result.puzzle) {
    console.log(`  RESULT: FAIL boardSize=${result.boardSize} lines=${result.lineCounts.v}/${result.lineCounts.h} clusters=${result.clusterCount} marks=${result.marks}`);
    console.log(`  error: ${result.error}`);
    continue;
  }
  const b = debug.best;
  console.log(`  RESULT: ok n=${result.boardSize} marks=${result.marks}`);
  // region map + marks map
  for (let r = 0; r < b.n; r++) {
    let row = "";
    for (let c = 0; c < b.n; c++) {
      const k = b.kinds[r * b.n + c];
      const a = b.assign[r * b.n + c];
      row += k === "crown" ? "C" : k === "x" ? "x" : GLYPHS[a % 16];
    }
    console.log(`  ${row}`);
  }
  // per-cell lab for cells whose cluster is suspicious (list all compactly)
  const labs = [];
  for (let i = 0; i < b.lab.length; i++) {
    const L = b.lab[i].map((v) => Math.round(v));
    labs.push(`${GLYPHS[b.assign[i] % 16]}(${L.join(",")})`);
  }
  console.log(`  labs: ${labs.join(" ")}`);
  // stroke metrics per cell: kind d1 d2 plain bright white dark conf
  const met = [];
  for (let i = 0; i < b.kinds.length; i++) {
    const f = (v) => v.toFixed(2);
    met.push(
      `${i}:${b.kinds[i][0]} d=${f(b.d1Bright[i])},${f(b.d2Bright[i])} p=${f(b.plainBright[i])} b=${f(b.brightFrac[i])} w=${f(b.whiteFrac[i])} dk=${f(b.darkFrac[i])} c=${b.markConf[i].toFixed(2)}`,
    );
  }
  console.log(`  metrics:\n    ${met.join("\n    ")}`);
  const solved = solvePuzzle(result.puzzle);
  console.log(`  solver: ${solved.status}${solved.errors.length ? " :: " + solved.errors.slice(0, 4).join(" | ") : ""}`);
}
