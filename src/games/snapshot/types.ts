/** Snapshot minigame: guess where + when a painting/photo is from.
 *
 * Data is link-only: images stay on Wikimedia Commons (hotlinked via
 * Special:FilePath thumbs). This file is the curated fallback set so the
 * game works offline; `scripts/fetch-snapshot.mjs` can regenerate/expand it.
 */

export interface SnapshotItem {
  /** Stable id, e.g. `wd-Q12418` or `manual-...`. */
  id: string;
  title: string;
  creator: string;
  kind: "painting" | "photo";
  /** Hotlink thumb (Commons Special:FilePath with width). No bytes stored. */
  image: string;
  /** Commons file / article page for attribution. */
  page: string;
  /** Depicted location. */
  lat: number;
  lon: number;
  placeName: string;
  /** Year depicted / created. */
  year: number;
  license: string;
}

export function isSnapshotItem(v: unknown): v is SnapshotItem {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["id"] === "string" &&
    typeof o["title"] === "string" &&
    typeof o["creator"] === "string" &&
    (o["kind"] === "painting" || o["kind"] === "photo") &&
    typeof o["image"] === "string" &&
    typeof o["page"] === "string" &&
    typeof o["lat"] === "number" &&
    Number.isFinite(o["lat"]) &&
    typeof o["lon"] === "number" &&
    Number.isFinite(o["lon"]) &&
    typeof o["placeName"] === "string" &&
    typeof o["year"] === "number" &&
    Number.isInteger(o["year"]) &&
    typeof o["license"] === "string"
  );
}
