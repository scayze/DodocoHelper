import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MAX_LIMIT,
  dayKeyUTC,
  isLeaderboardGame,
  isValidDay,
} from "../src/leaderboard/types.js";
import {
  getLeaderboard,
  submitScore,
  tinderCounts,
  tinderExport,
  tinderMarkSeen,
  tinderNoteRendered,
  tinderPoolCountRange,
  tinderPoolRemove,
  tinderPoolTakeRange,
  tinderSeenByDecade,
  tinderVote,
  type Db,
} from "./db.js";
import { dailySeedsFor } from "./daily-seed.js";
import { validateSubmit } from "./validate.js";
import {
  harvestHistorypinStep,
  isPinId,
  nextKeyword,
  pickBucketOrder,
  toCard,
  type TinderCard,
} from "./tinder.js";

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
  size(): number;
} {
  const hits = new Map<string, number[]>();
  function sweep(now: number): void {
    // Bound memory: drop fully-expired keys. Runs at most once per
    // window-full map (amortized), so per-request cost stays O(1).
    if (hits.size <= 5000) return;
    for (const [k, list] of hits) {
      if (list.every((t) => now - t >= windowMs)) hits.delete(k);
      if (hits.size <= 4000) break;
    }
  }
  return {
    hit(key: string, now: number = Date.now()): boolean {
      const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (list.length >= max) {
        hits.set(key, list);
        return false;
      }
      list.push(now);
      hits.set(key, list);
      sweep(now);
      return true;
    },
    size(): number {
      return hits.size;
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

/** Lazy refill from Historypin (no auth, no key). Buckets are served
 *  least-curated-decades first; each bucket tops up via harvest steps only
 *  when its pool runs dry. Warm refills are pure DB reads (instant); cold
 *  ones cost list + detail fetches (~1s apart). */
/** Serialize upstream work across concurrent refills: the second waiter
 *  re-checks pool coverage after the first finishes and usually skips. */
let harvestGate: Promise<void> = Promise.resolve();
async function gated<T>(thunk: () => Promise<T>): Promise<T> {
  const prev = harvestGate;
  let release!: () => void;
  harvestGate = new Promise<void>((r) => {
    release = r;
  });
  await prev;
  try {
    return await thunk();
  } finally {
    release();
  }
}
async function serveTinderNext(db: Db, limit: number): Promise<TinderCard[]> {
  const cards: TinderCard[] = [];
  const taken = new Set<string>();
  const seenCounts = tinderSeenByDecade(db);
  const order = pickBucketOrder(seenCounts);
  // Shared harvest budget per call: top up until it can serve, but never
  // grind through all buckets — the client prefetches again for the rest.
  let stepsLeft = 4;
  for (const { bucket } of order) {
    if (cards.length >= limit) break;
    const need = limit - cards.length;
    // Top up this bucket's pool until it can serve (max 2 harvest steps
    // and a shared per-call budget; steps are skipped entirely when the
    // pool already covers it, and short serves are topped up next call).
    for (let s = 0; s < 2 && stepsLeft > 0 && tinderPoolCountRange(db, bucket.from, bucket.to) < need; s++) {
      try {
        await gated(async () => {
          if (stepsLeft > 0 && tinderPoolCountRange(db, bucket.from, bucket.to) < need) {
            stepsLeft--;
            await harvestHistorypinStep(db, bucket, nextKeyword());
          }
        });
      } catch {
        break;
      }
    }
    const rows = tinderPoolTakeRange(db, bucket.from, bucket.to, need);
    const served: string[] = [];
    for (const row of rows) {
      if (cards.length >= limit) break;
      if (taken.has(row.image)) {
        served.push(row.image); // stale pool row shadowing a served image: drop it.
        continue;
      }
      taken.add(row.image);
      served.push(row.image);
      const card = toCard({
        pinId: row.qid,
        title: row.label || row.title,
        image: row.thumb && row.thumb !== row.image ? row.image : (row.thumb || row.image),
        fallbackImage: row.thumb && row.thumb !== row.image ? row.thumb : null,
        sourceImage: row.image,
        year: row.year,
        lat: row.lat,
        lon: row.lon,
        page: row.page,
        license: row.license,
        blurb: row.description,
      });
      tinderMarkSeen(db, [{
        eventQid: row.qid, image: row.image, title: card.title, placeName: card.placeName,
        lat: card.lat, lon: card.lon, year: card.year, pointInTime: String(card.year),
        page: card.page, thumb: card.fallbackImage ?? card.image, license: card.license, blurb: card.blurb,
        blurbSource: card.blurbSource,
      }]);
      cards.push(card);
    }
    if (served.length > 0) tinderPoolRemove(db, served);
  }
  return cards;
}

export function createHandler(db: Db, opts: AppOptions = {}) {
  const submitLimit = opts.submitLimit ?? createLimiter(30, 60_000);
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

    if (req.method === "GET" && url.pathname === "/api/daily-seed") {
      if (!getLimit.hit(`get:${ip}`)) {
        sendJson(res, 429, { error: "Too many requests. Try again soon." });
        return;
      }
      const day = url.searchParams.get("day") ?? dayKeyUTC(now());
      if (!isValidDay(day)) {
        sendJson(res, 400, { error: "day must be YYYY-MM-DD." });
        return;
      }
      if (day > dayKeyUTC(now())) {
        sendJson(res, 400, { error: "day must not be in the future." });
        return;
      }
      sendJson(res, 200, dailySeedsFor(day));
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
      const { entry, duplicate } = submitScore(db, checked.value, now());
      if (duplicate) {
        sendJson(res, 409, {
          error: "Score already submitted for this game today.",
          entry,
          duplicate: true,
        });
        return;
      }
      sendJson(res, 201, { entry, duplicate: false });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/tinder/next") {
      if (!getLimit.hit(`tinder:${ip}`)) {
        sendJson(res, 429, { error: "Too many requests. Try again soon." });
        return;
      }
      const limitRaw = Number(url.searchParams.get("limit") ?? "4");
      const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 12) : 4;
      try {
        const cards = await serveTinderNext(db, limit);
        sendJson(res, 200, { cards, counts: tinderCounts(db) });
      } catch (e) {
        sendJson(res, 502, { error: `Upstream lookup failed: ${String(e).slice(0, 140)}` });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/tinder/vote") {
      if (!submitLimit.hit(`tinder-vote:${ip}`)) {
        sendJson(res, 429, { error: "Too many votes. Try again later." });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: "Body must be valid JSON." });
        return;
      }
      const b = parsed as Record<string, unknown>;
      const pinId = typeof b["pinId"] === "string" ? b["pinId"] : typeof b["eventQid"] === "string" ? (b["eventQid"] as string) : "";
      const image = typeof b["image"] === "string" ? b["image"] : "";
      // URL that actually rendered client-side (may be the fallback).
      const rendered = typeof b["rendered"] === "string" && (b["rendered"] as string).startsWith("http")
        ? (b["rendered"] as string).slice(0, 500)
        : image;
      const decision = b["decision"];
      if (!isPinId(pinId) || !image.startsWith("http")) {
        sendJson(res, 400, { error: "pinId + image required." });
        return;
      }
      if (decision !== "accepted" && decision !== "rejected") {
        sendJson(res, 400, { error: "decision must be accepted|rejected." });
        return;
      }
      const ok = tinderVote(db, pinId, image, decision);
      if (ok) tinderNoteRendered(db, pinId, image, rendered);
      sendJson(res, ok ? 200 : 404, { ok, counts: tinderCounts(db) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/tinder/stats") {
      sendJson(res, 200, { counts: tinderCounts(db) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/tinder/export") {
      const decision = url.searchParams.get("decision") === "rejected" ? "rejected" : "accepted";
      sendJson(res, 200, { items: tinderExport(db, decision) });
      return;
    }

    sendJson(res, 404, { error: "Not found." });
  };
}
