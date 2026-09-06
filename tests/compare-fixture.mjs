// Dev-only exact-match check: compares extraction output against a
// hand-transcribed test_fixtures/<name>.expected.json {size, regions, initial}.
// Regions compared up to id permutation (canonical first-occurrence relabel).
// Usage: node tests/compare-fixture.mjs <name>... (with dist built)
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "pngjs";
const { PNG } = pkg;
import jpeg from "jpeg-js";
import { extractFromPixels } from "../dist/src/lib/extract.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "test_fixtures");

function decode(name) {
  const buf = readFileSync(join(dir, name));
  if (name.endsWith(".png")) {
    const p = PNG.sync.read(buf);
    return { data: new Uint8ClampedArray(p.data), w: p.width, h: p.height };
  }
  const j = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512 });
  return { data: new Uint8ClampedArray(j.data), w: j.width, h: j.height };
}

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

/** Relabel grid ids by first-occurrence order -> canonical partition form. */
function canonical(grid) {
  const map = new Map();
  let next = 0;
  return grid.map((row) =>
    row.map((v) => {
      if (!map.has(v)) map.set(v, next++);
      return map.get(v);
    }),
  );
}

let failed = 0;
for (const name of process.argv.slice(2)) {
  const base = name.replace(/\.(png|jpg|jpeg)$/i, "");
  const expPath = join(dir, `${base}.expected.json`);
  if (!existsSync(expPath)) {
    console.log(`${name}: no expected file, SKIP`);
    continue;
  }
  const exp = JSON.parse(readFileSync(expPath, "utf8"));
  const img = capMaxSide(decode(name), 1000);
  const res = extractFromPixels(img.data, img.w, img.h);
  if (!res.ok || !res.puzzle) {
    console.log(`${name}: EXTRACTION FAILED: ${res.error}`);
    failed++;
    continue;
  }
  const got = res.puzzle;
  const errs = [];
  if (got.size !== exp.size) errs.push(`size ${got.size} != ${exp.size}`);
  const n = exp.size;
  if (got.size === n) {
    const a = canonical(got.regions);
    const b = canonical(exp.regions);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (a[r][c] !== b[r][c]) errs.push(`region (${r},${c}): got-part ${a[r][c]} vs exp-part ${b[r][c]}`);
      }
    }
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (got.initial[r][c] !== exp.initial[r][c]) {
          errs.push(`mark (${r},${c}): got ${got.initial[r][c]} vs exp ${exp.initial[r][c]}`);
        }
      }
    }
  }
  if (errs.length === 0) {
    console.log(`${name}: EXACT MATCH (n=${n})`);
  } else {
    failed++;
    console.log(`${name}: ${errs.length} mismatches (n=${got.size})`);
    for (const e of errs.slice(0, 25)) console.log(`   ${e}`);
  }
}
process.exit(failed ? 1 : 0);
