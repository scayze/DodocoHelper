import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { formatClock } from "../src/leaderboard/api.js";
import { localDailySeeds, mulberry32, timeUntilNextDaily, dailyCompleteMessage } from "../src/games/daily.js";
import { fnv1a } from "../src/games/rng.js";
import { SEED_SALT, dailySeedsFor } from "../server/daily-seed.js";
import { openDb } from "../server/db.js";
import { createHandler } from "../server/app.js";

describe("formatClock", () => {
  it("counts up from 0:00 in m:ss", () => {
    assert.equal(formatClock(0), "0:00");
    assert.equal(formatClock(999), "0:00");
    assert.equal(formatClock(59_000), "0:59");
    assert.equal(formatClock(60_000), "1:00");
    assert.equal(formatClock(65_000), "1:05");
    assert.equal(formatClock(12 * 60_000 + 34_000), "12:34");
  });

  it("rolls hours as h:mm:ss", () => {
    assert.equal(formatClock(3_600_000), "1:00:00");
    assert.equal(formatClock(3_723_000), "1:02:03");
  });
});

describe("timeUntilNextDaily", () => {
  it("counts down to the next UTC midnight in XXh MMm", () => {
    assert.equal(timeUntilNextDaily(new Date("2026-09-09T12:00:00Z")), "12h 00m");
    assert.equal(timeUntilNextDaily(new Date("2026-09-09T23:45:30Z")), "00h 14m");
    assert.equal(timeUntilNextDaily(new Date("2026-09-09T00:00:00Z")), "24h 00m");
  });

  it("handles month and year rollovers", () => {
    assert.equal(
      timeUntilNextDaily(new Date("2026-09-30T22:15:00Z")),
      "01h 45m",
    );
    assert.equal(
      timeUntilNextDaily(new Date("2026-12-31T18:30:00Z")),
      "05h 30m",
    );
  });

  it("dailyCompleteMessage embeds the countdown for all finishes", () => {
    assert.equal(
      dailyCompleteMessage(new Date("2026-09-09T12:00:00Z")),
      "Daily complete. Next one in 12h 00m.",
    );
  });
});

describe("daily seeds", () => {
  it("mulberry32 is deterministic per seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b(), b()];
    assert.deepEqual(seqA, seqB);
    const c = mulberry32(43);
    assert.notEqual(c(), seqA[0]);
  });

  it("local fallback seeds are stable per day with all four games", () => {
    const first = localDailySeeds("2026-09-09");
    const second = localDailySeeds("2026-09-09");
    assert.deepEqual(first, second);
    assert.equal(first.day, "2026-09-09");
    for (const game of ["crowns", "minesweeper", "seasons", "tents"] as const) {
      assert.equal(Number.isInteger(first.seeds[game]), true);
    }
    const other = localDailySeeds("2026-09-10");
    assert.notDeepEqual(first.seeds, other.seeds);
  });

  it("server seeds are deterministic per day and differ per game", () => {
    const first = dailySeedsFor("2026-09-09");
    const second = dailySeedsFor("2026-09-09");
    assert.deepEqual(first, second);
    const games = Object.values(first.seeds);
    assert.equal(new Set(games).size, 4);
    for (const seed of games) {
      assert.equal(Number.isInteger(seed), true);
      assert.ok(seed >= 0 && seed < 2 ** 32);
    }
  });

  it("client and server daily seeds build on the same FNV-1a core", () => {
    const day = "2026-09-09";
    // Client offline fallback hashes the bare day+game key.
    assert.equal(localDailySeeds(day).seeds.crowns, fnv1a(`${day}:crowns`));
    // Server seeds salt the key; both sides must hash identically.
    assert.equal(dailySeedsFor(day).seeds.crowns, fnv1a(`${SEED_SALT}:${day}:crowns`));
  });
});

describe("daily-seed endpoint", () => {
  function fakeReq(url: string): Readable {
    const stream = new Readable({ read() {} });
    Object.assign(stream, {
      url,
      method: "GET",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    });
    process.nextTick(() => stream.push(null));
    return stream;
  }

  function call(
    handler: (req: never, res: never) => Promise<void>,
    url: string,
  ): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      const res = {
        writeHead(status: number) {
          (res as { status?: number }).status = status;
        },
        end(data?: string) {
          try {
            resolve({
              status: (res as { status?: number }).status ?? 0,
              json: JSON.parse(String(data ?? "")),
            });
          } catch (e) {
            reject(e);
          }
        },
      };
      void handler(fakeReq(url) as never, res as never).catch(reject);
    });
  }

  it("serves deterministic seeds, rejects bad and future days", async () => {
    const db = openDb(":memory:");
    const fixedNow = new Date("2026-09-09T12:00:00Z");
    const handler = createHandler(db, { now: () => fixedNow });

    const res = (await call(handler, "/api/daily-seed?day=2026-09-09")) as {
      status: number;
      json: { day: string; seeds: Record<string, number> };
    };
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, dailySeedsFor("2026-09-09"));

    const def = (await call(handler, "/api/daily-seed")) as {
      status: number;
      json: { day: string };
    };
    assert.equal(def.status, 200);
    assert.equal(def.json.day, "2026-09-09");

    assert.equal((await call(handler, "/api/daily-seed?day=not-a-day")).status, 400);
    assert.equal((await call(handler, "/api/daily-seed?day=2026-09-10")).status, 400);
    db.close();
  });
});
