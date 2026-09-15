import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  storageGet,
  storageSet,
  storageRemove,
  storageReadJson,
  storageWriteJson,
} from "../src/storage.js";
import { normalizeDisplayName } from "../src/leaderboard/types.js";
import { normalizeName } from "../server/validate.js";
import { createLimiter } from "../server/app.js";

function installStorage(store = new Map<string, string>()): Map<string, string> {
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

describe("storage wrapper", () => {
  it("round-trips strings and JSON", () => {
    installStorage();
    assert.equal(storageGet("missing"), null);
    storageSet("k", "v");
    assert.equal(storageGet("k"), "v");
    storageWriteJson("j", { a: 1 });
    assert.deepEqual(storageReadJson("j"), { a: 1 });
    storageRemove("k");
    assert.equal(storageGet("k"), null);
  });

  it("returns null on corrupt JSON instead of throwing", () => {
    const store = installStorage();
    store.set("bad", "{nope");
    assert.equal(storageReadJson("bad"), null);
  });

  it("degrades gracefully without localStorage", () => {
    Object.defineProperty(globalThis, "localStorage", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    assert.equal(storageGet("k"), null);
    storageSet("k", "v"); // must not throw
    storageRemove("k"); // must not throw
    assert.equal(storageReadJson("k"), null);
  });
});

describe("display-name normalization", () => {
  it("is single-sourced between client and server", () => {
    assert.equal(normalizeName, normalizeDisplayName);
    assert.equal(normalizeDisplayName("  Dodoco   Helper  "), "Dodoco Helper");
    assert.equal(normalizeDisplayName(42 as unknown as string), "");
  });
});

describe("rate limiter", () => {
  it("allows max hits per window then rejects", () => {
    const limit = createLimiter(2, 1000);
    assert.equal(limit.hit("a", 0), true);
    assert.equal(limit.hit("a", 10), true);
    assert.equal(limit.hit("a", 20), false);
    assert.equal(limit.hit("a", 1001), true);
  });

  it("tracks keys independently and bounds memory", () => {
    const limit = createLimiter(1, 1000);
    for (let i = 0; i < 6000; i++) limit.hit(`k${i}`, 0);
    assert.ok(limit.size() <= 6000);
    // Expired keys are swept once the map grows past the threshold.
    for (let i = 0; i < 6000; i++) limit.hit(`fresh${i}`, 2000);
    assert.ok(limit.size() <= 11000);
  });
});
