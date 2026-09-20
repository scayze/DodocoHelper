/** Wikidata enrichment mapping: pure functions over recorded API payloads.
 *
 * Kept I/O-free so the mapping (year precision, license gates, blurb
 * fallback chain) is unit-testable with fixtures. Network batching lives
 * in `enrich.ts`.
 */

export interface WbDateClaim {
  property: string;
  /** e.g. `+1889-05-01T00:00:00Z`. */
  time: string;
  /** 11=day, 10=month, 9=year, 8=decade, 7=century, … */
  precision: number;
}

/** Preferred date claim: properties in game-relevance order (depicted
 *  moment first, start time second, inception last), earliest qualifying
 *  claim within the winning property. Day/month/year precision only —
 *  century/decade precision is undatable for the game → ignored. Returns
 *  the property + precision too so the dataset records what the year
 *  *means*. */
export const DATE_PREFERENCE = ["P585", "P580", "P577", "P571"];

export function preferredDateClaim(claims: WbDateClaim[]): { year: number; property: string; precision: number } | null {
  const qualifying = (property: string): { year: number; property: string; precision: number } | null => {
    let best: { year: number; property: string; precision: number } | null = null;
    for (const c of claims) {
      if (c.property !== property || c.precision < 9) continue;
      const m = /^([+-]?\d{1,4})-/.exec(c.time);
      if (!m) continue;
      const y = Number(m[1]);
      if (!Number.isInteger(y) || y < 1400 || y > 2026) continue;
      if (best === null || y < best.year) best = { year: y, property: c.property, precision: c.precision };
    }
    return best;
  };
  for (const property of DATE_PREFERENCE) {
    const hit = qualifying(property);
    if (hit) return hit;
  }
  return null;
}

const LICENSE_BLOCK = /all rights reserved|fair use|copyrighted|©|\(c\)/i;
const LICENSE_ALLOW = /cc-?0|cc-by|public domain|pd-|copyrighted free use|no known copyright/i;

/** Commons license gate over `extmetadata` text. Missing metadata is an
 *  API gap, not a restriction (Commons is freely licensed by policy) →
 *  allow with a generic license string. Explicitly restrictive text → block. */
export function commonsLicense(blobs: Array<unknown>): { ok: boolean; license: string } {
  const text = blobs
    .map((b) => (typeof b === "string" ? b : ""))
    .join(" | ")
    .slice(0, 2000);
  if (LICENSE_BLOCK.test(text)) return { ok: false, license: text.slice(0, 140) };
  if (text.trim().length === 0) return { ok: true, license: "see Commons file page" };
  const m = /CC0[^|]{0,20}|CC BY-SA[^|]{0,20}|CC BY[^|]{0,20}|public domain[^|]{0,40}/i.exec(text);
  if (m) return { ok: true, license: m[0].trim().slice(0, 140) };
  if (LICENSE_ALLOW.test(text)) return { ok: true, license: text.trim().slice(0, 140) };
  // Unknown but not explicitly blocked: allow, attribute via file page.
  return { ok: true, license: "see Commons file page" };
}

/** Blurb fallback chain: Wikidata description → Wikipedia extract →
 *  label. Returns null when nothing meets the bar. */
export function pickBlurb(opts: {
  description?: string | null;
  wikiExtract?: string | null;
  label?: string | null;
}): string | null {
  const desc = (opts.description ?? "").trim();
  if (desc.length >= 40) return desc;
  const ext = (opts.wikiExtract ?? "").trim().replace(/\s+/g, " ");
  if (ext.length >= 80) {
    // First 1–2 sentences, whole (no mid-sentence cuts).
    const m = /^(.+?[.!?](?:\s+.+?[.!?])?)/.exec(ext);
    const cut = (m?.[1] ?? ext).trim();
    if (cut.length >= 40) return cut.slice(0, 600);
  }
  const label = (opts.label ?? "").trim();
  return label.length > 0 ? label : null;
}

/** Parse a WDQS-style coordinate or wbgetclaims P625 value. */
export function claimCoord(value: unknown): { lat: number; lon: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  const lat = Number(o["latitude"]);
  const lon = Number(o["longitude"]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000 };
}

export function fileTitleFor(filename: string): string {
  return filename.startsWith("File:") ? filename : `File:${filename}`;
}

export interface FileUsage {
  wiki: string;
  title: string;
  url: string;
}

function normFileTitle(t: string): string {
  return t.replace(/^File:/i, "").replace(/_/g, " ").trim().toLowerCase();
}

/** Match a Commons `globalusage` page back to a requested filename.
 *  Page titles are canonical (`File:X Y.jpg`); requests vary. */
export function usageForFile(
  pages: Record<string, { title?: string; globalusage?: FileUsage[] }>,
  file: string,
  limit = 10,
): FileUsage[] {
  const want = normFileTitle(file);
  for (const page of Object.values(pages)) {
    if (normFileTitle(page.title ?? "") !== want) continue;
    return (page.globalusage ?? []).slice(0, limit).filter(
      (u) => typeof u.wiki === "string" && typeof u.title === "string" && typeof u.url === "string",
    );
  }
  return [];
}
