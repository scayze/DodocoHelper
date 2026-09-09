import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  dayKeyUTC,
  isValidDay,
  shiftDayKey,
} from "../src/leaderboard/types.js";
import { validateSubmit } from "../server/validate.js";
import { getLeaderboard, openDb, submitScore } from "../server/db.js";
import { createHandler } from "../server/app.js";
import {
  clearQueuedWins,
  dropQueuedWin,
  getDisplayName,
  hasValidName,
  isValidDisplayName,
  loadQueuedWins,
  queueWin,
  setDisplayName,
  todayUTC,
} from "../src/leaderboard/api.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

describe("leaderboard day helpers", () => {
  it("formats the UTC day key", () => {
    assert.equal(dayKeyUTC(new Date("2026-09-09T23:30:00Z")), "2026-09-09");
    assert.equal(dayKeyUTC(new Date("2026-09-10T00:30:00+02:00")), "2026-09-09");
  });

  it("rejects impossible days", () => {
    assert.equal(isValidDay("2026-09-09"), true);
    assert.equal(isValidDay("2026-02-30"), false);
    assert.equal(isValidDay("09-09"), false);
    assert.equal(isValidDay("2026-13-01"), false);
    assert.equal(isValidDay(42), false);
  });

  it("shifts day keys across month and year boundaries", () => {
    assert.equal(shiftDayKey("2026-09-09", -1), "2026-09-08");
    assert.equal(shiftDayKey("2026-09-09", 1), "2026-09-10");
    assert.equal(shiftDayKey("2026-03-01", -1), "2026-02-28");
    assert.equal(shiftDayKey("2024-03-01", -1), "2024-02-29");
    assert.equal(shiftDayKey("2026-01-01", -1), "2025-12-31");
    assert.equal(shiftDayKey("2026-12-31", 1), "2027-01-01");
  });
});

describe("validateSubmit", () => {
  it("accepts a minimal valid submit and normalizes the name", () => {
    const res = validateSubmit({
      game: "crowns",
      displayName: "  Dodoco  ",
      clientId: UUID_A,
      durationMs: 95_000,
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value.displayName, "Dodoco");
      assert.equal(res.value.moves, 0);
      assert.equal(res.value.hintsUsed, 0);
    }
  });

  it("rejects bad game, name, uuid and duration", () => {
    assert.equal(
      validateSubmit({ game: "chess", displayName: "AB", clientId: UUID_A, durationMs: 5 }).ok,
      false,
    );
    assert.equal(
      validateSubmit({ game: "crowns", displayName: "x", clientId: UUID_A, durationMs: 5 }).ok,
      false,
    );
    assert.equal(
      validateSubmit({ game: "crowns", displayName: "AB", clientId: "nope", durationMs: 5 }).ok,
      false,
    );
    assert.equal(
      validateSubmit({ game: "crowns", displayName: "AB", clientId: UUID_A, durationMs: 0 }).ok,
      false,
    );
    assert.equal(
      validateSubmit({ game: "crowns", displayName: "<img>", clientId: UUID_A, durationMs: 5 })
        .ok,
      false,
    );
  });
});

describe("display names", () => {
  function installStorage(): void {
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
  }

  it("validates names like the server and treats invalid as nameless", () => {
    installStorage();
    assert.equal(hasValidName(), false);
    assert.equal(isValidDisplayName("x"), false);
    assert.equal(isValidDisplayName("<img>"), false);
    assert.equal(isValidDisplayName("  Dodoco  "), true);
    setDisplayName("  Dodoco  ");
    assert.equal(getDisplayName(), "Dodoco");
    assert.equal(hasValidName(), true);
  });

  it("keeps the earliest win per game, oldest first", () => {
    installStorage();
    queueWin({ game: "crowns", durationMs: 90_000 });
    queueWin({ game: "crowns", durationMs: 30_000 });
    queueWin({ game: "tents", durationMs: 50_000, moves: 12 });
    const wins = loadQueuedWins();
    assert.deepEqual(wins.map((w) => w.game), ["crowns", "tents"]);
    assert.equal(wins[0].durationMs, 90_000);
    dropQueuedWin("crowns");
    assert.deepEqual(loadQueuedWins().map((w) => w.game), ["tents"]);
    clearQueuedWins();
    assert.deepEqual(loadQueuedWins(), []);
  });

  it("drops entries queued on a previous day", () => {
    installStorage();
    const ls = (globalThis as unknown as { localStorage: Storage }).localStorage;
    queueWin({ game: "crowns", durationMs: 90_000 });
    assert.equal(loadQueuedWins().length, 1);
    // Rewrite the stored entry with a stale day stamp.
    const raw = ls.getItem("dodoco:pendingWins")!;
    const parsed = JSON.parse(raw) as { version: number; wins: Array<Record<string, unknown>> };
    parsed.wins[0]["day"] = "2000-01-01";
    ls.setItem("dodoco:pendingWins", JSON.stringify(parsed));
    assert.deepEqual(loadQueuedWins(), []);
  });

  it("migrates the legacy single pending win once", () => {
    installStorage();
    const ls = (globalThis as unknown as { localStorage: Storage }).localStorage;
    ls.setItem(
      "dodoco:pendingWin",
      JSON.stringify({ game: "seasons", durationMs: 70_000, moves: 9, hintsUsed: 0, at: Date.now() }),
    );
    const wins = loadQueuedWins();
    assert.equal(wins.length, 1);
    assert.equal(wins[0].game, "seasons");
    assert.equal(wins[0].day, todayUTC());
    assert.equal(ls.getItem("dodoco:pendingWin"), null);
    // Second load does not duplicate it.
    assert.equal(loadQueuedWins().length, 1);
  });
});

describe("one-shot daily store", () => {
  it("accepts the first submit per player per day and rejects retries", () => {
    const db = openDb(":memory:");
    const day = new Date("2026-09-09T12:00:00Z");
    const first = submitScore(
      db,
      { game: "minesweeper", displayName: "Paimon", clientId: UUID_A, durationMs: 120_000, moves: 40, hintsUsed: 0 },
      day,
    );
    assert.equal(first.duplicate, false);
    // Retry — even faster — is rejected and leaves the stored row untouched.
    const retry = submitScore(
      db,
      { game: "minesweeper", displayName: "Paimon!", clientId: UUID_A, durationMs: 60_000, moves: 50, hintsUsed: 0 },
      day,
    );
    assert.equal(retry.duplicate, true);
    assert.equal(retry.entry.durationMs, 120_000);
    assert.equal(retry.entry.displayName, "Paimon");
    // Other players, games and days are isolated.
    submitScore(
      db,
      { game: "minesweeper", displayName: "Dodoco", clientId: UUID_B, durationMs: 90_000, moves: 30, hintsUsed: 0 },
      day,
    );
    const board = getLeaderboard(db, "minesweeper", "2026-09-09", 20);
    assert.deepEqual(board.map((e) => e.displayName), ["Dodoco", "Paimon"]);
    assert.equal(getLeaderboard(db, "minesweeper", "2026-09-10", 20).length, 0);
    assert.equal(getLeaderboard(db, "crowns", "2026-09-09", 20).length, 0);
    db.close();
  });
});

describe("api handler", () => {
  function fakeReq(url: string, method = "GET", body?: string) {
    const stream = new Readable({ read() {} });
    Object.assign(stream, {
      url,
      method,
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    });
    if (body !== undefined) {
      process.nextTick(() => {
        stream.push(body);
        stream.push(null);
      });
    } else {
      process.nextTick(() => stream.push(null));
    }
    return stream;
  }

  function call(
    handler: (req: never, res: never) => Promise<void>,
    url: string,
    method = "GET",
    body?: string,
  ): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const res = {
        writeHead(status: number) {
          (res as { status?: number }).status = status;
        },
        end(data?: string) {
          try {
            resolve({
              status: (res as { status?: number }).status ?? 0,
              json: JSON.parse(Buffer.concat(chunks).toString() + (data ?? "")),
            });
          } catch (e) {
            reject(e);
          }
        },
        write(chunk: string) {
          chunks.push(Buffer.from(chunk));
          return true;
        },
      };
      void handler(fakeReq(url, method, body) as never, res as never).catch(reject);
    });
  }

  it("serves healthz, rejects bad submits, accepts one daily score", async () => {
    const db = openDb(":memory:");
    const fixedNow = new Date("2026-09-09T12:00:00Z");
    const handler = createHandler(db, { now: () => fixedNow });
    const health = await call(handler, "/api/healthz");
    assert.equal(health.status, 200);

    const bad = await call(
      handler,
      "/api/scores",
      "POST",
      JSON.stringify({ game: "crowns", displayName: "x", clientId: UUID_A, durationMs: 5 }),
    );
    assert.equal(bad.status, 400);

    const good = await call(
      handler,
      "/api/scores",
      "POST",
      JSON.stringify({
        game: "crowns",
        displayName: "Dodoco",
        clientId: UUID_A,
        durationMs: 83_000,
        moves: 18,
        hintsUsed: 1,
      }),
    );
    assert.equal(good.status, 201);
    assert.equal((good.json as { duplicate: boolean }).duplicate, false);

    const retry = await call(
      handler,
      "/api/scores",
      "POST",
      JSON.stringify({
        game: "crowns",
        displayName: "Dodoco",
        clientId: UUID_A,
        durationMs: 10_000,
        moves: 5,
        hintsUsed: 0,
      }),
    );
    assert.equal(retry.status, 409);

    const board = (await call(handler, "/api/leaderboard?game=crowns")) as {
      status: number;
      json: { day: string; entries: Array<{ displayName: string }> };
    };
    assert.equal(board.status, 200);
    assert.equal(board.json.day, "2026-09-09");
    assert.equal(board.json.entries[0].displayName, "Dodoco");
    db.close();
  });
});
