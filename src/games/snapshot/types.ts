/** Snapshot minigame: guess where + when a photograph was taken.
 *
 * Data is link-only: images stay on Wikimedia Commons (hotlinked direct
 * upload.wikimedia.org thumbs). Regenerate with `scripts/fetch-snapshot.mjs`.
 */

export interface SnapshotItem {
  /** Stable id, e.g. `ph-Q243-1889-3`. */
  id: string;
  /** Short human label (usually the depicted place/event). */
  title: string;
  /** Hotlink thumb (direct upload.wikimedia.org URL). No bytes stored. */
  image: string;
  /** Commons file page for attribution. */
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
  /** Blurb attribution URL (Commons file or Wikipedia article). */
  blurbSource: string;
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
    typeof o["blurbSource"] === "string"
  );
}
