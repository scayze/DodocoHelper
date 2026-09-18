/** Persisted Snapshot round state (single round per daily/endless). */

export interface SnapshotStored {
  itemId: string;
  itemIndex: number;
  guessLat: number | null;
  guessLon: number | null;
  guessYear: number;
  /** Active in-square screen. */
  view: "photo" | "when" | "where" | "results";
  revealed: boolean;
  distKm: number | null;
  yearErr: number | null;
  score: number | null;
  resultReported: boolean;
}

export function isSnapshotStored(v: unknown): v is SnapshotStored {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const numOrNull = (x: unknown): boolean =>
    x === null || (typeof x === "number" && Number.isFinite(x as number));
  return (
    typeof o["itemId"] === "string" &&
    typeof o["itemIndex"] === "number" &&
    Number.isInteger(o["itemIndex"]) &&
    numOrNull(o["guessLat"]) &&
    numOrNull(o["guessLon"]) &&
    typeof o["guessYear"] === "number" &&
    Number.isInteger(o["guessYear"]) &&
    (o["view"] === "photo" ||
      o["view"] === "when" ||
      o["view"] === "where" ||
      o["view"] === "results") &&
    typeof o["revealed"] === "boolean" &&
    numOrNull(o["distKm"]) &&
    numOrNull(o["yearErr"]) &&
    (o["score"] === null || (typeof o["score"] === "number" && Number.isInteger(o["score"]))) &&
    typeof o["resultReported"] === "boolean"
  );
}
