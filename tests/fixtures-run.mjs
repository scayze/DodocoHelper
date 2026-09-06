#!/usr/bin/env node
// Iterates every fixture, runs the full OpenCV extraction, and reports how the
// extracted board compares to the fixture's .expected.json.
//
// Usage:
//   node tests/fixtures-run.mjs            # report-only
//   node tests/fixtures-run.mjs --check    # exit non-zero if a screenshot fixture fails
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { decode as decodeJpeg } from "jpeg-js";
import { extractBoardFromRGBA, relabelMatch } from "../dist/src/lib/extract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(ROOT, "test_fixtures");

function decodeImage(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") {
    const d = decodeJpeg(fs.readFileSync(p));
    return { data: new Uint8ClampedArray(d.data), w: d.width, h: d.height };
  }
  const png = PNG.sync.read(fs.readFileSync(p));
  return { data: new Uint8ClampedArray(png.data), w: png.width, h: png.height };
}

const SUBS = {
  ScreenshotFixtures: "screenshot",
  PhoneFixtures: "phone",
};

function collect() {
  const out = [];
  for (const dir of Object.keys(SUBS)) {
    const full = path.join(FIXTURES, dir);
    for (const f of fs.readdirSync(full)) {
      if (!/\.(png|jpe?g)$/i.test(f)) continue;
      out.push({ path: path.join(full, f), kind: SUBS[dir] });
    }
  }
  return out;
}

const check = process.argv.includes("--check");
const fixtures = collect();
let pass = 0;
let fail = 0;
const failures = [];

for (const fx of fixtures) {
  const expFile = fx.path.replace(/\.(png|jpe?g)$/i, ".expected.json");
  const expected = fs.existsSync(expFile)
    ? JSON.parse(fs.readFileSync(expFile, "utf8"))
    : null;
  if (!expected) {
    failures.push(`${fx.path}: no expected.json`);
    fail++;
    continue;
  }
  const img = decodeImage(fx.path);
  const puzzle = await extractBoardFromRGBA(img.data, img.w, img.h);
  const short = path.relative(FIXTURES, fx.path);
  if (!puzzle) {
    console.log(`  FAIL  ${short}  (no board detected)`);
    failures.push(`${short}: no board detected`);
    fail++;
    continue;
  }
  const regionOK = puzzle.size === expected.size && relabelMatch(puzzle.regions, expected.regions);
  const initExact = JSON.stringify(puzzle.initial) === JSON.stringify(expected.initial);
  const status =
    regionOK && initExact
      ? "PASS"
      : regionOK
        ? "PARTIAL (regions ok)"
        : "FAIL";
  console.log(
    `  ${status.padEnd(22)} ${short.padEnd(34)} size=${puzzle.size}/${expected.size} regions=${regionOK ? "ok" : "MISMATCH"} initial=${initExact ? "exact" : "diff"}`,
  );
  if (regionOK) {
    pass++;
  } else {
    failures.push(`${short}: region mismatch (size ${puzzle.size} vs ${expected.size})`);
    fail++;
  }
}

console.log("");
console.log(`fixtures: ${pass} passed, ${fail} failed, ${fixtures.length} total`);

// Phones are best-effort; all screenshots must pass for --check to succeed.
if (check) {
  const failName = (f) => path.relative(FIXTURES, f.path);
  const gatingFailed = fixtures.some(
    (f) =>
      f.kind === "screenshot" &&
      failures.some((msg) => msg.startsWith(failName(f))),
  );
  if (gatingFailed) {
    console.error("One or more screenshot fixtures failed.");
    process.exitCode = 1;
  }
}