/** Polite upstream client for Wikidata-family APIs.
 *
 * WDQS (`query.wikidata.org`) is a shared public endpoint: ~60s timeouts,
 * concurrency caps, 429/maxlag throttling. The Action APIs
 * (`wikidata.org/w/api.php`, Commons, Wikipedia REST) tolerate more but
 * still require a descriptive User-Agent. Every Wikidata-family fetch goes
 * through here: single-flight per channel, min spacing + jitter, honor
 * Retry-After, exponential backoff, daily SPARQL budget, circuit breaker.
 */
import type { Db } from "../../db.js";

export const WD_UA =
  "DodocoHelper-tinder/1.0 (https://github.com/dodoco; contact: tinder-harvest)";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export interface PoliteOptions {
  /** Min ms between calls on this channel. */
  spacingMs: number;
  /** Per-attempt timeout. */
  timeoutMs: number;
  /** Retries on network/429/5xx (4xx fast-fail). */
  tries: number;
}

export const SPARQL_POLITE: PoliteOptions = { spacingMs: 3000, timeoutMs: 60000, tries: 2 };
export const API_POLITE: PoliteOptions = { spacingMs: 1000, timeoutMs: 20000, tries: 3 };

interface ChannelState {
  lastAt: number;
  failures: number;
  cooldownUntil: number;
}

const channels = new Map<string, ChannelState>();
let gate: Promise<void> = Promise.resolve();

function stateFor(channel: string): ChannelState {
  let s = channels.get(channel);
  if (!s) {
    s = { lastAt: 0, failures: 0, cooldownUntil: 0 };
    channels.set(channel, s);
  }
  return s;
}

/** Test hook: reset in-process throttling state. */
export function resetPoliteForTests(): void {
  channels.clear();
  gate = Promise.resolve();
}

async function serialized<T>(thunk: () => Promise<T>): Promise<T> {
  const prev = gate;
  let release!: () => void;
  gate = new Promise<void>((r) => {
    release = r;
  });
  await prev;
  try {
    return await thunk();
  } finally {
    release();
  }
}

function retryAfterMs(res: Response): number | null {
  const v = res.headers.get("retry-after");
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, 60000);
  const when = Date.parse(v);
  if (Number.isFinite(when)) return Math.max(0, Math.min(when - Date.now(), 60000));
  return null;
}

export class UpstreamBusyError extends Error {
  constructor(msg: string) {
    super(msg);
  }
}

/** Daily SPARQL budget, persisted so restarts don't reset the count. */
export function sparqlBudgetExhausted(db: Db, dailyBudget: number): boolean {
  const day = new Date().toISOString().slice(0, 10);
  ensureStatsTable(db);
  const row = db
    .prepare("SELECT sparql_count AS n FROM wd_stats WHERE day = ?")
    .get(day) as unknown as { n: number } | undefined;
  return (row?.n ?? 0) >= dailyBudget;
}

export function noteSparqlCall(db: Db, ms: number, ok: boolean): void {
  const day = new Date().toISOString().slice(0, 10);
  ensureStatsTable(db);
  db.prepare(
    `INSERT INTO wd_stats(day, sparql_count, sparql_errors, sparql_ms_total)
     VALUES(?, 1, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       sparql_count = sparql_count + 1,
       sparql_errors = sparql_errors + excluded.sparql_errors,
       sparql_ms_total = sparql_ms_total + excluded.sparql_ms_total`,
  ).run(day, ok ? 0 : 1, Math.round(ms));
}

function ensureStatsTable(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS wd_stats(
       day TEXT PRIMARY KEY,
       sparql_count INTEGER NOT NULL DEFAULT 0,
       sparql_errors INTEGER NOT NULL DEFAULT 0,
       sparql_ms_total INTEGER NOT NULL DEFAULT 0
     );`,
  );
}

export interface FetchOpts extends PoliteOptions {
  channel: string;
  /** Extra headers. */
  headers?: Record<string, string>;
}

/** Polite GET returning the response (caller reads the body). Throws
 *  `UpstreamBusyError` during cooldown instead of hammering upstream. */
export async function politeGet(url: string, opts: FetchOpts): Promise<Response> {
  return serialized(async () => {
    const st = stateFor(opts.channel);
    if (Date.now() < st.cooldownUntil) {
      throw new UpstreamBusyError(`cooling down: ${opts.channel}`);
    }
    let backoff = 2000;
    for (let attempt = 0; ; attempt++) {
      const wait = opts.spacingMs + Math.random() * 500 - (Date.now() - st.lastAt);
      if (wait > 0) await sleep(wait);
      st.lastAt = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, {
          signal: ctrl.signal,
          headers: { "User-Agent": WD_UA, Accept: "application/json", ...(opts.headers ?? {}) },
        });
      } catch (e) {
        clearTimeout(timer);
        if (attempt >= opts.tries - 1) {
          st.failures++;
          if (st.failures >= 5) st.cooldownUntil = Date.now() + 30 * 60 * 1000;
          throw e;
        }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 10000);
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) {
        st.failures = 0;
        return res;
      }
      const retryable = res.status === 429 || res.status >= 500;
      await res.arrayBuffer().catch(() => null);
      if (retryable && attempt < opts.tries - 1) {
        await sleep(retryAfterMs(res) ?? backoff);
        backoff = Math.min(backoff * 2, 10000);
        continue;
      }
      if (retryable) {
        st.failures++;
        if (st.failures >= 5) st.cooldownUntil = Date.now() + 30 * 60 * 1000;
      }
      throw new Error(`HTTP ${res.status} for ${url.slice(0, 100)}`);
    }
  });
}

export async function politeGetJson<T>(url: string, opts: FetchOpts): Promise<T> {
  const res = await politeGet(url, opts);
  return (await res.json()) as T;
}
