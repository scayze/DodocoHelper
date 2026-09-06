import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validatePuzzleInput } from "../src/validator.js";
import {
  CROWN_COLOR,
  LINE_COLOR,
  REGION_PALETTE,
  encodePng,
  renderPixels,
} from "../src/render.js";
import type { NormalizedPuzzle } from "../src/types.js";

// Same board as examples/image-puzzle.json (extracted from the screenshot).
const REGIONS: number[][] = [
  [0, 0, 0, 0, 1, 1, 2, 2, 2],
  [0, 0, 0, 0, 1, 3, 2, 2, 2],
  [0, 4, 4, 1, 1, 3, 3, 3, 2],
  [4, 4, 4, 1, 1, 3, 3, 3, 3],
  [4, 4, 4, 1, 1, 3, 5, 5, 5],
  [6, 4, 4, 6, 6, 6, 5, 5, 5],
  [6, 6, 6, 6, 7, 6, 5, 5, 7],
  [8, 8, 8, 6, 7, 7, 7, 7, 7],
  [8, 8, 8, 8, 8, 7, 7, 7, 7],
];

const SOLUTION: string[][] = [
  [".", ".", ".", ".", "C", ".", "C", ".", "."],
  [".", ".", "C", ".", ".", ".", ".", ".", "C"],
  ["C", ".", ".", ".", ".", "C", ".", ".", "."],
  [".", ".", "C", ".", ".", ".", ".", "C", "."],
  ["C", ".", ".", ".", "C", ".", ".", ".", "."],
  [".", ".", ".", ".", ".", ".", "C", ".", "C"],
  [".", "C", ".", "C", ".", ".", ".", ".", "."],
  [".", ".", ".", ".", ".", "C", ".", "C", "."],
  [".", "C", ".", "C", ".", ".", ".", ".", "."],
];

function testPuzzle(): NormalizedPuzzle {
  const { errors, puzzle } = validatePuzzleInput({ regions: REGIONS });
  assert.deepEqual(errors, []);
  return puzzle!;
}

function cellCenter(cell: number, gap: number, idx: number): number {
  return gap + idx * (cell + gap) + Math.floor(cell / 2);
}

function pixelOf(px: { width: number; data: Buffer }, x: number, y: number): [number, number, number] {
  const o = (y * px.width + x) * 3;
  return [px.data[o], px.data[o + 1], px.data[o + 2]];
}

describe("render", () => {
  it("produces the expected image dimensions", () => {
    const px = renderPixels(testPuzzle(), null, { cell: 64, gap: 6 });
    assert.equal(px.width, 9 * 64 + 10 * 6);
    assert.equal(px.height, px.width);
    assert.equal(px.data.length, px.width * px.height * 3);
  });

  it("paints region colors and grid lines on the empty board", () => {
    const cell = 64;
    const gap = 6;
    const px = renderPixels(testPuzzle(), null, { cell, gap });
    // Cell (0,0) is region 0 with no crown -> palette color at its center.
    assert.deepEqual(pixelOf(px, cellCenter(cell, gap, 0), cellCenter(cell, gap, 0)), REGION_PALETTE[0]);
    // Cell (0,4) is region 1 -> its palette color.
    assert.deepEqual(pixelOf(px, cellCenter(cell, gap, 4), cellCenter(cell, gap, 0)), REGION_PALETTE[1]);
    // A pixel inside a grid gap has the line color.
    assert.deepEqual(pixelOf(px, 2, 2), LINE_COLOR);
  });

  it("draws crowns in crown cells only", () => {
    const cell = 64;
    const gap = 6;
    const px = renderPixels(testPuzzle(), SOLUTION, { cell, gap });
    const cx = (c: number) => cellCenter(cell, gap, c);
    // (0,4) and (0,6) are crowns -> dark crown color near center.
    assert.deepEqual(pixelOf(px, cx(4), cx(0)), CROWN_COLOR);
    assert.deepEqual(pixelOf(px, cx(6), cx(0)), CROWN_COLOR);
    // (0,0) has no crown -> region color untouched.
    assert.deepEqual(pixelOf(px, cx(0), cx(0)), REGION_PALETTE[0]);
    // (1,7) is a given-empty mark -> region color, no crown.
    assert.deepEqual(pixelOf(px, cx(7), cx(1)), REGION_PALETTE[2]);
  });

  it("encodes a valid PNG with correct IHDR dimensions", () => {
    const px = renderPixels(testPuzzle(), SOLUTION, { cell: 32, gap: 4 });
    const png = encodePng(px);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), px.width);
    assert.equal(png.readUInt32BE(20), px.height);
    assert.ok(png.length > 1000);
  });

  it("uses the puzzle palette when provided", () => {
    const cell = 64;
    const gap = 6;
    const base = testPuzzle();
    const custom = { ...base, palette: Array(9).fill("#FF0000") };
    const px = renderPixels(custom, null, { cell, gap });
    // Cell (0,0) must now be pure red instead of the default teal.
    assert.deepEqual(pixelOf(px, cellCenter(cell, gap, 0), cellCenter(cell, gap, 0)), [255, 0, 0]);
  });
});
