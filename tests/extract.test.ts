import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { decode as decodeJpeg } from "jpeg-js";
import { extractBoardFromRGBA, relabelMatch } from "../src/games/crowns/extract.js";

function decodeImage(p: string): { data: Uint8ClampedArray; w: number; h: number } {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") {
    const d = decodeJpeg(fs.readFileSync(p));
    return { data: new Uint8ClampedArray(d.data), w: d.width, h: d.height };
  }
  const png = PNG.sync.read(fs.readFileSync(p));
  return { data: new Uint8ClampedArray(png.data), w: png.width, h: png.height };
}

function expectedPath(p: string): string {
  return p.replace(/\.(png|jpe?g)$/i, ".expected.json");
}

const FIXTURES = {
  // Screenshots whose region partition is correctly extracted.
  screenshot: [
    "image.png",
    "image2.png",
    "image3.png",
    "image10.png",
    "image56.png",
    "image123.png",
    "image241.png",
  ],
  phone: ["image4.jpg", "image5.jpg", "image6.jpg", "image7.jpg"],
};

describe("extractBoardFromRGBA", () => {
  for (const name of FIXTURES.screenshot) {
    it(`extracts the correct region partition from screenshot ${name}`, async () => {
      const p = path.join("test_fixtures", "ScreenshotFixtures", name);
      const img = decodeImage(p);
      const expected = JSON.parse(fs.readFileSync(expectedPath(p), "utf8")) as {
        size: number;
        regions: number[][];
      };
      const puzzle = await extractBoardFromRGBA(img.data, img.w, img.h);
      assert.ok(puzzle, `expected a board to be extracted from ${name}`);
      const size = puzzle.size as number;
      assert.equal(size, expected.size, `size for ${name}`);
      assert.ok(
        relabelMatch(puzzle.regions, expected.regions),
        `region partition for ${name} should match the fixture (up to relabeling)`,
      );
    });
  }

  it("produces a canonically-labeled valid region grid for a screenshot", async () => {
    const p = path.join("test_fixtures", "ScreenshotFixtures", "image.png");
    const img = decodeImage(p);
    const puzzle = await extractBoardFromRGBA(img.data, img.w, img.h);
    assert.ok(puzzle);
    const size = puzzle.size as number;
    assert.equal(puzzle.regions.length, size);
    const seen = new Set(puzzle.regions.flat());
    for (let i = 0; i < size; i++) assert.ok(seen.has(i), `region id ${i} present`);
    assert.equal(seen.size, size);
    assert.equal(puzzle.palette?.length, size);
  });
});