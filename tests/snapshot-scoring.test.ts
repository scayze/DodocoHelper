import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  locationScore,
  yearScore,
  yearTau,
  totalScore,
} from "../src/games/snapshot/logic.js";

describe("snapshot locationScore anchors", () => {
  it("gives full marks under 500 m", () => {
    assert.equal(locationScore(0), 50);
    assert.equal(locationScore(0.3), 50);
    assert.equal(locationScore(0.5), 50);
  });
  it("hits the agreed anchors", () => {
    assert.equal(locationScore(50), 45);
    assert.equal(locationScore(500), 37);
    assert.equal(locationScore(2000), 22);
    assert.equal(locationScore(5000), 8);
    assert.equal(locationScore(10000), 2);
    assert.equal(locationScore(20000), 0);
    assert.equal(locationScore(25000), 0);
  });
  it("interpolates between anchors", () => {
    assert.equal(locationScore(10), 49);
    assert.equal(locationScore(100), 44);
    assert.equal(locationScore(1000), 31);
    assert.equal(locationScore(3000), 16);
  });
  it("rejects bad input", () => {
    assert.equal(locationScore(NaN), 0);
    assert.equal(locationScore(-5), 0);
    assert.equal(locationScore(Infinity), 0);
  });
});

describe("snapshot yearTau", () => {
  it("is strict for modern years", () => {
    assert.equal(yearTau(2025), 45);
    assert.equal(yearTau(1900), 45);
  });
  it("widens further back, capped at 400", () => {
    assert.equal(yearTau(1780), 135);
    assert.equal(yearTau(1600), 270);
    assert.equal(yearTau(1400), 400);
    assert.equal(yearTau(1000), 400);
  });
});

describe("snapshot yearScore", () => {
  it("scores 40 for 10 y off a modern year", () => {
    assert.equal(yearScore(10, 1900), 40);
    assert.equal(yearScore(-10, 2000), 40);
    assert.equal(yearScore(0, 1900), 50);
  });
  it("scores 40 for 30 y off a 1780 year", () => {
    assert.equal(yearScore(30, 1780), 40);
    assert.equal(yearScore(-30, 1780), 40);
  });
  it("matches the agreed modern curve", () => {
    assert.equal(yearScore(50, 1900), 16);
    assert.equal(yearScore(100, 1900), 5);
  });
  it("is more forgiving for old eras", () => {
    assert.equal(yearScore(50, 1780), 35);
    assert.equal(yearScore(100, 1780), 24);
  });
});

describe("snapshot totalScore", () => {
  it("sums location + era-scaled year", () => {
    // 50 km -> 45, 10 y off modern -> 40.
    assert.equal(totalScore(50, 10, 2000), 85);
    assert.equal(totalScore(0, 0, 1900), 100);
  });
});
