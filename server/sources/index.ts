/** Source registry: route qids/ids to the owning adapter. */
import { historypinAdapter } from "./historypin.js";
import type { SourceAdapter } from "./types.js";
import { wikidataAdapter } from "./wikidata/index.js";

export const allAdapters: SourceAdapter[] = [historypinAdapter, wikidataAdapter];

export type SourceMode = "historypin" | "wikidata" | "mixed";

export function sourceMode(): SourceMode {
  const v = (process.env["SOURCE"] ?? "mixed").toLowerCase();
  if (v === "wikidata" || v === "wd") return "wikidata";
  if (v === "mixed" || v === "all" || v === "both") return "mixed";
  return "historypin";
}

export function acceptsSourceId(id: string): boolean {
  return allAdapters.some((a) => a.isSourceId(id));
}

export function exportIdFor(eventQid: string, year: number): string {
  const owner = allAdapters.find((a) => a.isSourceId(eventQid));
  if (owner) return owner.exportId(eventQid, year);
  const clean = eventQid.replace(/^(hp:|wd:)/, "").replace(/[^A-Za-z0-9]+/g, "");
  return `src-${clean || "x"}-${year}`;
}
