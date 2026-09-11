import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CROWNS_DEFAULTS,
  MINES_DEFAULTS,
  SEASONS_DEFAULTS,
  TENTS_DEFAULTS,
  clampCrownsSettings,
  clampInt,
  clampMinesSettings,
  clampSeasonsSettings,
  clampTentsSettings,
  isEndlessUnlocked,
  loadEndlessSettings,
  saveEndlessSettings,
  setEndlessUnlocked,
} from "../src/games/mode.js";

function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string): void => {
        store.set(k, String(v));
      },
      removeItem: (k: string): void => {
        store.delete(k);
      },
    },
    configurable: true,
    writable: true,
  });
  return store;
}

describe("clampInt", () => {
  it("clamps numbers and numeric strings, falls back otherwise", () => {
    assert.equal(clampInt(9, 6, 12, 9), 9);
    assert.equal(clampInt(99, 6, 12, 9), 12);
    assert.equal(clampInt(1, 6, 12, 9), 6);
    assert.equal(clampInt("10", 6, 12, 9), 10);
    assert.equal(clampInt("nope", 6, 12, 9), 9);
    assert.equal(clampInt(undefined, 6, 12, 9), 9);
    assert.equal(clampInt(7.6, 6, 12, 9), 8);
  });
});

describe("endless settings clampers", () => {
  it("keeps valid mines settings and clamps mines to half the board", () => {
    assert.deepEqual(clampMinesSettings({ size: 9, mines: 15 }), { size: 9, mines: 15 });
    assert.deepEqual(clampMinesSettings({ size: 6, mines: 60 }).mines, 18);
    assert.deepEqual(clampMinesSettings({ size: 99, mines: -5 }), { size: 12, mines: 1 });
  });

  it("clamps crowns size and crowns-per-unit", () => {
    assert.deepEqual(clampCrownsSettings({ size: 9, crowns: 2 }), { size: 9, crowns: 2 });
    assert.deepEqual(clampCrownsSettings({ size: 4, crowns: 5 }), { size: 6, crowns: 2 });
  });

  it("clamps seasons and tents sizes", () => {
    assert.deepEqual(clampSeasonsSettings({ size: 10 }), { size: 10 });
    assert.deepEqual(clampSeasonsSettings({ size: 3 }), { size: 6 });
    assert.deepEqual(clampTentsSettings({ size: 8 }), { size: 8 });
    assert.deepEqual(clampTentsSettings({ size: 20 }), { size: 10 });
  });
});

describe("endless settings persistence", () => {
  it("returns defaults when nothing is stored and round-trips saves", () => {
    installStorage();
    assert.deepEqual(loadEndlessSettings("minesweeper"), MINES_DEFAULTS);
    assert.deepEqual(loadEndlessSettings("crowns"), CROWNS_DEFAULTS);
    assert.deepEqual(loadEndlessSettings("seasons"), SEASONS_DEFAULTS);
    assert.deepEqual(loadEndlessSettings("tents"), TENTS_DEFAULTS);
    saveEndlessSettings("minesweeper", { size: 12, mines: 30 });
    assert.deepEqual(loadEndlessSettings("minesweeper"), { size: 12, mines: 30 });
  });

  it("repairs corrupt or out-of-range stored values", () => {
    const store = installStorage();
    store.set("dodoco:endless:tents", "not-json{{");
    assert.deepEqual(loadEndlessSettings("tents"), TENTS_DEFAULTS);
    store.set("dodoco:endless:seasons", JSON.stringify({ size: 99 }));
    assert.deepEqual(loadEndlessSettings("seasons"), { size: 12 });
  });
});

describe("endless unlock", () => {
  it("is locked by default, unlocks for the stored day only", () => {
    installStorage();
    assert.equal(isEndlessUnlocked("2026-09-11"), false);
    setEndlessUnlocked("2026-09-11");
    assert.equal(isEndlessUnlocked("2026-09-11"), true);
    assert.equal(isEndlessUnlocked("2026-09-12"), false);
  });
});
