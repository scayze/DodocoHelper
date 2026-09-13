/** Deterministic PRNG + hashing shared by board generation (client) and daily
 * seed derivation (server). These must stay bit-identical on both sides: the
 * server seeds a day, the client regenerates the board from that seed. Client
 * code may also import them via re-exports from `./daily.js`.
 */

/**
 * FNV-1a string hash to a uint32. Seeds daily boards; also the client's
 * offline fallback hash. Do not change without rotating the deploy salt and
 * updating `tests/daily.test.ts`.
 */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic PRNG (mulberry32); shared by all daily board generation. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}