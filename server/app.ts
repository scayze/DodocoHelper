import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MAX_LIMIT,
  dayKeyUTC,
  isLeaderboardGame,
  isValidDay,
} from "../src/leaderboard/types.js";
import {
  getLeaderboard,
  poolDecadeHistogram,
  submitScore,
  tinderCounts,
  tinderExport,
  tinderMarkServed,
  tinderPoolBySource,
  tinderPoolTakeRange,
  tinderVote,
  type Db,
} from "./db.js";
import { dailySeedsFor } from "./daily-seed.js";
import { validateSubmit } from "./validate.js";
import { DECADE_BUCKETS, type TinderCard } from "./tinder.js";
import { acceptsSourceId, allAdapters } from "./sources/index.js";
import type { TinderPoolRow, TinderSourceFilter } from "./db.js";

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

/** Pure-DB serving: the request path never touches upstream for any source.
 *  Historypin trickles in via its background worker (see
 *  `server/sources/historypin.ts`), Wikidata via bulk worker cycles (see
 *  `server/sources/wikidata/`). Cards are dealt scarcity-weighted (thin pool
 *  regions first, nothing starves) and stay servable until voted. */
/** Build a display card for a pool row via its owning adapter
 *  (Historypin applies its CDN fresh key; Wikidata passes through). */
function cardForPoolRow(row: TinderPoolRow): TinderCard {
  const owner = allAdapters.find((a) => a.isSourceId(row.qid)) ?? allAdapters[0]!;
  return owner.toCard({
    sourceId: row.qid,
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
    blurbSource: row.blurbSource || row.page,
    dateKind: row.dateKind ?? "",
    datePrecision: row.datePrecision ?? 0,
    article: row.article ?? "",
    fileUsage: row.fileUsage ?? "",
    subjectTypes: row.subjectTypes ?? "",
  });
}

/** Scarcity-weighted decade order (weighted probability): thin pool
 *  regions are served first, but everything stays eligible — no bucket
 *  can starve the rest. Exponential-race shuffle over weights
 *  w = 1/(1+count). */
function scarcityOrder(db: Db, source: TinderSourceFilter | null): Array<{ bucket: (typeof DECADE_BUCKETS)[number] }> {
  const counts = poolDecadeHistogram(db, source);
  const keyed = DECADE_BUCKETS.map((bucket, i) => {
    const w = 1 / (1 + (counts[i] ?? 0));
    const r = Math.random();
    return { bucket, key: -Math.log(1 - r) / w };
  });
  keyed.sort((a, b) => a.key - b.key);
  return keyed;
}
/** Pool source filter from `?source=`: `hp` (Historypin), `wd` (Wikidata), else all. */
function parseSourceParam(v: string | null): TinderSourceFilter | null {
  if (v === "hp" || v === "historypin") return "hp";
  if (v === "wd" || v === "wikidata") return "wd";
  return null;
}
async function serveTinderNext(db: Db, limit: number, source: TinderSourceFilter | null = null): Promise<TinderCard[]> {
  const cards: TinderCard[] = [];
  const taken = new Set<string>();
  const served: string[] = [];
  const order = scarcityOrder(db, source);
  // Round-robin across decades (scarcest first): one card per decade per
  // pass, so every response mixes years instead of filling greedily from
  // a single decade. Pure reads — rows stay until voted (reload-safe).
  for (let pass = 0; pass < 2 && cards.length < limit; pass++) {
    let progress = false;
    for (const { bucket } of order) {
      if (cards.length >= limit) break;
      const rows = tinderPoolTakeRange(db, bucket.from, bucket.to, 2, source);
      const row = rows.find((r) => !taken.has(r.image));
      if (!row) continue;
      taken.add(row.image);
      served.push(row.image);
      cards.push(cardForPoolRow(row));
      progress = true;
    }
    if (!progress) break;
  }
  if (served.length > 0) tinderMarkServed(db, served);
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
        const cards = await serveTinderNext(db, limit, parseSourceParam(url.searchParams.get("source")));
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
      if (!acceptsSourceId(pinId) || !image.startsWith("http")) {
        sendJson(res, 400, { error: "pinId + image required." });
        return;
      }
      if (decision !== "accepted" && decision !== "rejected") {
        sendJson(res, 400, { error: "decision must be accepted|rejected." });
        return;
      }
      // First vote wins: the decided row is assembled server-side from the
      // served pool row, so the POST carries only ids. Re-votes and votes
      // for unserved cards return ok:false.
      const ok = tinderVote(db, { eventQid: pinId, image, rendered, decision });
      sendJson(res, ok ? 200 : 404, { ok, counts: tinderCounts(db) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/tinder/stats") {
      sendJson(res, 200, { counts: tinderCounts(db), poolBySource: tinderPoolBySource(db) });
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
