import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MAX_LIMIT,
  dayKeyUTC,
  isLeaderboardGame,
  isValidDay,
} from "../src/leaderboard/types.js";
import { getLeaderboard, submitScore, type Db } from "./db.js";
import { validateSubmit } from "./validate.js";

const MAX_BODY_BYTES = 10_000;

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Tiny sliding-window limiter: max `max` hits per `windowMs` per key. */
export function createLimiter(max: number, windowMs: number): {
  hit(key: string, now?: number): boolean;
} {
  const hits = new Map<string, number[]>();
  return {
    hit(key: string, now: number = Date.now()): boolean {
      const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (list.length >= max) {
        hits.set(key, list);
        return false;
      }
      list.push(now);
      hits.set(key, list);
      return true;
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim().slice(0, 64);
  }
  return (req.socket.remoteAddress ?? "unknown").slice(0, 64);
}

export interface AppOptions {
  submitLimit?: { hit(key: string, now?: number): boolean };
  getLimit?: { hit(key: string, now?: number): boolean };
  now?: () => Date;
}

export function createHandler(db: Db, opts: AppOptions = {}) {
  const submitLimit = opts.submitLimit ?? createLimiter(5, 10 * 60_000);
  const getLimit = opts.getLimit ?? createLimiter(60, 60_000);
  const now = opts.now ?? ((): Date => new Date());

  return async function handler(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const ip = clientIp(req);

    if (req.method === "GET" && url.pathname === "/api/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/leaderboard") {
      if (!getLimit.hit(`get:${ip}`)) {
        sendJson(res, 429, { error: "Too many requests. Try again soon." });
        return;
      }
      const game = url.searchParams.get("game") ?? "";
      const day = url.searchParams.get("day") ?? dayKeyUTC(now());
      const limitRaw = Number(url.searchParams.get("limit") ?? "20");
      if (!isLeaderboardGame(game)) {
        sendJson(res, 400, { error: "Unknown game." });
        return;
      }
      if (!isValidDay(day)) {
        sendJson(res, 400, { error: "day must be YYYY-MM-DD." });
        return;
      }
      const limit = Number.isInteger(limitRaw)
        ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT)
        : 20;
      sendJson(res, 200, {
        game,
        day,
        entries: getLeaderboard(db, game, day, limit),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/scores") {
      if (!submitLimit.hit(`post:${ip}`)) {
        sendJson(res, 429, { error: "Too many submits. Try again later." });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: "Body must be valid JSON." });
        return;
      }
      const checked = validateSubmit(parsed);
      if (!checked.ok) {
        sendJson(res, 400, { error: checked.error });
        return;
      }
      if (!submitLimit.hit(`client:${checked.value.clientId}`)) {
        sendJson(res, 429, { error: "That player submitted too recently." });
        return;
      }
      const { entry, improved } = submitScore(db, checked.value, now());
      sendJson(res, 201, { entry, improved });
      return;
    }

    sendJson(res, 404, { error: "Not found." });
  };
}
