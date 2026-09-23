/** Display labels for reverse-geocoded snapshot answers.
 *
 * Pure helpers (no DOM): `geoLabel` renders "City, Country" from the
 * enriched fields, `answerPlace` combines it with the curated placeName.
 */
import type { SnapshotItem } from "./types.js";
import { formatDistance } from "./logic.js";
import { geoLabel } from "../geo-label.js";

export { geoLabel };

function clean(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** "City, Country" chain with graceful fallbacks:
 *  city+country → "Paris, France"; city only; locality (oceans:
 *  "Atlantic Ocean"); subdivision; country; '' when unenriched. */
/** Details-tab answer line: "address, date" only — the title already sits
 *  above it, so neither the title nor an "Answer:" prefix is repeated.
 *  Geo label when enriched, else the placeName (unless it duplicates the
 *  title, then just the year). */
export function detailAnswerLine(item: Pick<SnapshotItem, "title" | "year" | "placeName" | "geoCity" | "geoLocality" | "geoSubdivision" | "geoCountryName">): string {
  const geo = geoLabel(item);
  if (geo) return `${geo}, ${item.year}`;
  const name = clean(item.placeName);
  if (name && name.toLowerCase() !== clean(item.title).toLowerCase()) return `${name}, ${item.year}`;
  return String(item.year);
}

/** Answer headline: curated name plus geo when available, e.g.
 *  "Eiffel Tower — Paris, France". Falls back to the plain placeName. */
export function answerPlace(item: Pick<SnapshotItem, "placeName" | "geoCity" | "geoLocality" | "geoSubdivision" | "geoCountryName">): string {
  const name = clean(item.placeName);
  const geo = geoLabel(item);
  if (!geo) return name;
  // Avoid "Paris — Paris, France" stutter when identical.
  if (geo.toLowerCase().startsWith(name.toLowerCase()) || name.toLowerCase().includes(geo.toLowerCase())) {
    return geo;
  }
  return `${name} — ${geo}`;
}

/** Results-bar miss row: distances only, e.g. "312 km off · 20 y early".
 *  No score, no place — those sit in their own rows. */
export function resultMissLine(distKm: number, yearErr: number): string {
  const distPart = distKm < 0.05 ? "spot on" : `${formatDistance(distKm)} off`;
  const e = Math.abs(yearErr);
  const yearPart = e === 0 ? "exact year" : `${e} y ${yearErr < 0 ? "early" : "late"}`;
  return `${distPart} · ${yearPart}`;
}

/** Results-bar place row: location & year, e.g. "Paris, France, 1889".
 *  Geo label when enriched, else the placeName. */
export function resultPlaceLine(
  item: Pick<SnapshotItem, "year" | "placeName" | "geoCity" | "geoLocality" | "geoSubdivision" | "geoCountryName">,
): string {
  const geo = geoLabel(item);
  const place = geo || clean(item.placeName);
  return place ? `${place}, ${item.year}` : String(item.year);
}
