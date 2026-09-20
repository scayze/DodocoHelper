/** Snapshot minigame: guess where + when a photograph was taken.
 *
 * Data is link-only: images stay on their host (currently Historypin pins
 * curated through the Tinder view). The dataset loads at runtime from
 * `/api/tinder/export` — same schema, separate table — never bundled.
 */

export interface SnapshotItem {
  /** Stable id, e.g. `ph-Q243-1889-3`. */
  id: string;
  /** Short human label (usually the depicted place/event). */
  title: string;
  /** Hotlink image URL (served by the pin host). No bytes stored. */
  image: string;
  /** Pin/file page for attribution. */
  page: string;
  /** Depicted location. */
  lat: number;
  lon: number;
  placeName: string;
  /** Year taken. */
  year: number;
  license: string;
  photographer?: string;
  /** 1-2 sentence explanation, plain-text English. */
  blurb: string;
  /** Blurb attribution URL (pin page or Wikipedia article). */
  blurbSource: string;
  /** UTC acceptance day (YYYY-MM-DD) from tinder `decided_at`. Missing on
   *  legacy exports; treated as always eligible. Daily D only picks
   *  entries with addedDay < D. */
  addedDay?: string;
}

export function isSnapshotItem(v: unknown): v is SnapshotItem {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["id"] === "string" &&
    typeof o["title"] === "string" &&
    typeof o["image"] === "string" &&
    typeof o["page"] === "string" &&
    typeof o["lat"] === "number" &&
    Number.isFinite(o["lat"]) &&
    typeof o["lon"] === "number" &&
    Number.isFinite(o["lon"]) &&
    typeof o["placeName"] === "string" &&
    typeof o["year"] === "number" &&
    Number.isInteger(o["year"]) &&
    typeof o["license"] === "string" &&
    (o["photographer"] === undefined || typeof o["photographer"] === "string") &&
    typeof o["blurb"] === "string" &&
    (o["blurb"] as string).length > 0 &&
    typeof o["blurbSource"] === "string" &&
    (o["addedDay"] === undefined || typeof o["addedDay"] === "string")
  );
}
