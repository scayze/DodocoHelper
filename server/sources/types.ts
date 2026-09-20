/** Shared Tinder source abstraction.
 *
 * Historypin is the current (and default) source. Wikidata (+ Commons
 * images + Wikipedia blurbs) is implemented as a second `SourceAdapter`
 * in `server/sources/wikidata/`. Anything source-specific (URL hacks,
 * license checks, query strategies, pacing) lives in the adapter — the
 * request path in `server/app.ts` and the game schema in
 * `src/games/snapshot/types.ts` stay source-neutral.
 */
import type { Db } from "../db.js";

export interface DecadeBucket {
  from: number;
  to: number;
}

export const DECADE_BUCKETS: DecadeBucket[] = [
  { from: 1700, to: 1800 },
  { from: 1800, to: 1850 },
  { from: 1850, to: 1900 },
  { from: 1900, to: 1920 },
  { from: 1920, to: 1940 },
  { from: 1940, to: 1960 },
  { from: 1960, to: 1980 },
  { from: 1980, to: 2000 },
  { from: 2000, to: 2026 },
];

/** Card served to the Tinder curator UI. `pinId` is the namespaced source
 *  id (`hp:<digits>` for Historypin, `wd:Q…` for Wikidata). */
export interface TinderCard {
  id: string;
  title: string;
  image: string;
  /** Second-chance URL when image fails at display time (null = none). */
  fallbackImage: string | null;
  page: string;
  lat: number;
  lon: number;
  placeName: string;
  year: number;
  license: string;
  blurb: string;
  blurbSource: string;
  /** Namespaced source id. Stable vote/dedupe namespace. */
  pinId: string;
  /** Stable vote/dedupe key (usually the canonical image URL). */
  sourceImage: string;
  /** Winning date property (`P571`/`P585`/…/`depicted`, '' = unknown). */
  dateKind: string;
  /** English Wikipedia article title about the subject ('' = none). */
  article: string;
  /** Display tag for the year, e.g. ` (built)`. Computed server-side. */
  dateTag: string;
  /** Tooltip explaining the tag. */
  dateHint: string;
}

/** P31 (instance of) → inception verb, priority-ordered (specific before
 *  generic — a row matches the first id present in its subject types). */
export const INCEPTION_VERBS: Array<[qid: string, verb: string]> = [
  ["Q16970", "built"], // church building
  ["Q2977", "built"], // cathedral
  ["Q32815", "built"], // mosque
  ["Q44613", "built"], // monastery
  ["Q44539", "built"], // temple
  ["Q12518", "built"], // tower
  ["Q23413", "built"], // castle
  ["Q16560", "built"], // palace
  ["Q11303", "built"], // skyscraper
  ["Q55488", "opened"], // railway station (P571 = opening date)
  ["Q928830", "opened"], // metro station
  ["Q22808403", "opened"], // underground station
  ["Q4312270", "opened"], // railway station above ground
  ["Q749622", "opened"], // Antarctic research station
  ["Q1248784", "built"], // airport
  ["Q12280", "built"], // bridge
  ["Q39715", "built"], // lighthouse
  ["Q27686", "built"], // hotel
  ["Q24354", "built"], // theatre
  ["Q3914", "built"], // school (photographed as building)
  ["Q483110", "built"], // stadium
  ["Q4989906", "built"], // monument
  ["Q57831", "built"], // fortress
  ["Q1785071", "built"], // fort
  ["Q109607", "built"], // ruins
  ["Q2116450", "built"], // manor estate
  ["Q5773747", "built"], // historic house
  ["Q19844914", "built"], // university building
  ["Q1088552", "built"], // catholic church building
  ["Q537127", "built"], // road bridge
  ["Q7123018", "built"], // packhorse bridge
  ["Q11435892", "built"], // okido (gate)
  ["Q41176", "built"], // building (catch-all, keep last among built)
  ["Q3305213", "painted"], // painting
  ["Q860861", "sculpted"], // sculpture
  ["Q125191", "taken"], // photograph
  ["Q11424", "released"], // film
  ["Q482994", "released"], // album
  ["Q571", "written"], // book
  ["Q11446", "launched"], // ship
  ["Q178561", "fought"], // battle
  ["Q1656682", "held"], // event
  ["Q515", "founded"], // city/town
  ["Q3957", "founded"], // town
  ["Q532", "founded"], // village
  ["Q486972", "founded"], // human settlement
  ["Q15078955", "founded"], // urban-type settlement (Russia)
  ["Q777120", "founded"], // borough (Pennsylvania)
  ["Q917092", "founded"], // municipality (Paraguay)
  ["Q3243765", "founded"], // municipality (Argentina)
  ["Q7830213", "founded"], // township (New Jersey)
  ["Q92755865", "founded"], // religious museum
  ["Q112132573", "founded"], // industrial museum
  ["Q3918", "founded"], // university (institution)
  ["Q43229", "founded"], // organization
  ["Q6256", "founded"], // country
  ["Q4830453", "founded"], // business
  ["Q7278", "founded"], // political party
  ["Q11032", "founded"], // newspaper
  ["Q23442", "formed"], // island
  ["Q8502", "formed"], // mountain
  ["Q4022", "formed"], // river
  ["Q23397", "formed"], // lake
  ["Q192287", "formed"], // administrative division
];

/** First priority-ordered verb matching the row's subject types (null =
 *  generic wording). `typesJson` is the stored `subject_types` blob. */
export function verbForTypes(typesJson: string | null | undefined): string | null {
  if (!typesJson) return null;
  let ids: unknown;
  try {
    ids = JSON.parse(typesJson);
  } catch {
    return null;
  }
  if (!Array.isArray(ids)) return null;
  const set = new Set(ids.filter((v): v is string => typeof v === "string"));
  for (const [qid, verb] of INCEPTION_VERBS) {
    if (set.has(qid)) return verb;
  }
  return null;
}

/** Display tag + tooltip for a card's year, from the stored date kind and
 *  subject types. Inception wording follows the subject (built/founded/
 *  painted/…); all other kinds are subject-independent. */
export function dateDisplay(
  dateKind: string | null | undefined,
  typesJson: string | null | undefined,
): { tag: string; hint: string } {
  switch (dateKind ?? "") {
    case "P571": {
      const verb = verbForTypes(typesJson);
      if (verb === "taken") return { tag: " (taken)", hint: "Photo taken then." };
      if (verb !== null) {
        return {
          tag: ` (${verb})`,
          hint: `Subject ${verb} then — the photo itself may be newer.`,
        };
      }
      return { tag: " (inception of subject)", hint: "Inception: when the subject came into being — the photo itself may be newer." };
    }
    case "P585":
      return { tag: " (date depicted)", hint: "Point in time: the moment captured in this photo." };
    case "P580":
      return { tag: " (subject started)", hint: "Start date of the depicted subject or event." };
    case "P577":
      return { tag: " (publication date)", hint: "When the depicted work was published — the photo may show an older subject." };
    case "depicted":
      return { tag: " (photo date)", hint: "Date the photo was taken, as given by the source." };
    default:
      return { tag: "", hint: "" };
  }
}

/** Canonical harvested item, before display-URL fixups. Adapters map
 *  their upstream records into this shape; the core builds `TinderCard`. */
export interface SourceCard {
  /** Namespaced source id: `hp:<digits>`, `wd:Q…`. */
  sourceId: string;
  title: string;
  /** Display image. */
  image: string;
  /** Display fallback (null = none). */
  fallbackImage?: string | null;
  /** Stable vote/dedupe key (same as image when canonical). */
  sourceImage: string;
  year: number;
  lat: number;
  lon: number;
  page: string;
  license: string;
  blurb: string;
  /** Blurb attribution URL (defaults to page). */
  blurbSource?: string | null;
  /** Winning date property (`P571`/`P585`/…/`depicted`, '' = unknown). */
  dateKind?: string | null;
  /** Precision of the winning date (11/10/9, 0 = unknown). */
  datePrecision?: number | null;
  /** English Wikipedia article title about the subject (null = none). */
  article?: string | null;
  /** JSON array of {wiki,title,url} file usages (null = none/unknown). */
  fileUsage?: string | null;
  /** JSON array of P31 subject-type QIDs (null = none/unknown). */
  subjectTypes?: string | null;
}

export interface SourceAdapter {
  /** Stable key: `historypin`, `wikidata`. */
  readonly key: string;
  /** True when `id` belongs to this source's namespace. */
  isSourceId(id: string): boolean;
  /** Next discovery query hint (keyword, slice key, …) or null for broad. */
  nextQuery(): string | null;
  /** One harvest step: discover → enrich → insert into `tinder_pool`.
   *  Must never throw fatally for routine upstream failures (return 0).
   *  Request-path adapters (Historypin) may do live fetches here;
   *  polite adapters (Wikidata) do live fetches only from the background
   *  worker and return 0 when called on the request path without budget. */
  harvestStep(
    db: Db,
    bucket: DecadeBucket,
    query: string | null,
    detailsPerStep?: number,
  ): Promise<number>;
  toCard(row: SourceCard): TinderCard;
  /** Stable Snapshot export id for an accepted row. */
  exportId(eventQid: string, year: number): string;
}

export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = t;
  }
  return arr;
}

export function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/** Base card builder with no source-specific URL rewriting. Adapters
 *  that need display-URL fixups (Historypin's CDN key) wrap this. */
export function buildBaseCard(row: SourceCard): TinderCard {
  const dd = dateDisplay(row.dateKind, row.subjectTypes);
  return {
    id: `${row.sourceId}-${row.year}-${shortHash(row.sourceImage)}`,
    title: row.title,
    image: row.image,
    page: row.page,
    lat: row.lat,
    lon: row.lon,
    placeName: row.title,
    year: row.year,
    license: row.license,
    blurb: row.blurb.trim() || row.title,
    blurbSource: row.blurbSource || row.page,
    dateKind: row.dateKind ?? "",
    article: row.article ?? "",
    dateTag: dd.tag,
    dateHint: dd.hint,
    pinId: row.sourceId,
    sourceImage: row.sourceImage,
    fallbackImage: row.fallbackImage ?? null,
  };
}
