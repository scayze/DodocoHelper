import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BOARD_STATE_VERSION,
  allBoardStateKeys,
  boardStateKey,
  clearBoardState,
  loadBoardState,
  saveBoardState,
} from "../src/games/persist.js";

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

const TODAY = "2026-09-11";

/** Minimal fake per-game state slice: any object with an integer `magic` passes. */
function isSample(value: unknown): value is { magic: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isInteger((value as { magic?: unknown }).magic)
  );
}

function saveDaily(store: Map<string, string>, day: string | null): void {
  store.set(
    boardStateKey("crowns", "daily"),
    JSON.stringify({
      v: BOARD_STATE_VERSION,
      day,
      elapsedMs: 42_000,
      timerLive: true,
      state: { magic: 7 },
    }),
  );
}

describe("board state persistence", () => {
  it("round-trips payloads for daily and endless", () => {
    installStorage();
    saveBoardState("crowns", "daily", {
      day: TODAY,
      elapsedMs: 12_345,
      timerLive: true,
      state: { magic: 7 },
    });
    saveBoardState("crowns", "endless", {
      day: null,
      elapsedMs: 1_000,
      timerLive: true,
      state: { magic: 8 },
    });
    assert.deepEqual(loadBoardState("crowns", "daily", isSample, TODAY), {
      state: { magic: 7 },
      elapsedMs: 12_345,
      timerLive: true,
    });
    assert.deepEqual(loadBoardState("crowns", "endless", isSample, TODAY), {
      state: { magic: 8 },
      elapsedMs: 1_000,
      timerLive: true,
    });
  });

  it("drops and clears a daily from any other day (new day = new seed)", () => {
    const store = installStorage();
    saveDaily(store, "2026-09-10");
    assert.equal(loadBoardState("crowns", "daily", isSample, TODAY), null);
    assert.equal(store.has(boardStateKey("crowns", "daily")), false);
  });

  it("accepts today's daily and keeps its elapsed time", () => {
    const store = installStorage();
    saveDaily(store, TODAY);
    const loaded = loadBoardState("crowns", "daily", isSample, TODAY);
    assert.ok(loaded);
    assert.equal(loaded!.elapsedMs, 42_000);
  });

  it("rejects malformed day values but endless payloads never age out", () => {
    const store = installStorage();
    saveDaily(store, "not-a-day");
    assert.equal(loadBoardState("crowns", "daily", isSample, TODAY), null);
    store.set(
      boardStateKey("tents", "endless"),
      JSON.stringify({ v: BOARD_STATE_VERSION, day: null, elapsedMs: 5, timerLive: false, state: { magic: 1 } }),
    );
    assert.deepEqual(loadBoardState("tents", "endless", isSample, TODAY), {
      state: { magic: 1 },
      elapsedMs: 5,
      timerLive: false,
    });
  });

  it("clears corrupt JSON, missing version, and mismatched state", () => {
    const store = installStorage();
    const key = boardStateKey("seasons", "daily");
    store.set(key, "not-json{{");
    assert.equal(loadBoardState("seasons", "daily", isSample, TODAY), null);
    assert.equal(store.has(key), false);

    store.set(
      key,
      JSON.stringify({ day: TODAY, elapsedMs: 1, timerLive: true, state: { magic: 1 } }),
    );
    assert.equal(loadBoardState("seasons", "daily", isSample, TODAY), null);

    store.set(
      key,
      JSON.stringify({
        v: BOARD_STATE_VERSION,
        day: TODAY,
        elapsedMs: 1,
        timerLive: true,
        state: { magic: "nope" },
      }),
    );
    assert.equal(loadBoardState("seasons", "daily", isSample, TODAY), null);
  });

  it("lists every board key for storage resets", () => {
    installStorage();
    assert.deepEqual(allBoardStateKeys(), [
      boardStateKey("crowns", "daily"),
      boardStateKey("crowns", "endless"),
      boardStateKey("minesweeper", "daily"),
      boardStateKey("minesweeper", "endless"),
      boardStateKey("seasons", "daily"),
      boardStateKey("seasons", "endless"),
      boardStateKey("tents", "daily"),
      boardStateKey("tents", "endless"),
      boardStateKey("snapshot", "daily"),
      boardStateKey("snapshot", "endless"),
      boardStateKey("shapes", "daily"),
      boardStateKey("shapes", "endless"),
    ]);
  });

  it("clearBoardState removes the key without throwing", () => {
    const store = installStorage();
    const key = boardStateKey("crowns", "endless");
    saveBoardState("crowns", "endless", {
      day: null,
      elapsedMs: 1,
      timerLive: true,
      state: { magic: 3 },
    });
    assert.ok(store.has(key));
    clearBoardState("crowns", "endless");
    assert.equal(store.has(key), false);
  });
});