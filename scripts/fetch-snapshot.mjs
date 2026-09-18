#!/usr/bin/env node
// Fetch Snapshot items (link-only) from Wikidata + Commons.
// Never downloads image bytes: only saves Special:FilePath hotlink URLs
// plus depicted-place coords and inception year.
//
// Usage:
//   node scripts/fetch-snapshot.mjs --limit 200
//   node scripts/fetch-snapshot.mjs --limit 200 --out src/games/snapshot/items.ts
//
// Merges with the curated fallback in the current items.ts (by id) so
// hand-checked entries are never lost; fetched Wikidata rows use `wd-` ids.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const DEFAULT_OUT = path.join(ROOT, "src/games/snapshot/items.ts");

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}
const LIMIT = Math.min(500, Math.max(20, Number(flag("--limit", "200")) || 200));
const OUT = flag("--out", DEFAULT_OUT);

const SPARQL = `SELECT ?item ?itemLabel ?image ?inception ?placeLabel ?coord WHERE {
  ?item wdt:P31/wdt:P279* wd:Q3305213 ;
        wdt:P18 ?image ;
        wdt:P571 ?inception ;
        wdt:P180 ?place .
  ?place wdt:P625 ?coord .
  FILTER(YEAR(?inception) >= 1400)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT ${LIMIT}`;

function coordFromWkt(wkt) {
  const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(wkt ?? "");
  if (!m) return null;
  return { lon: Number(m[1]), lat: Number(m[2]) };
}

function fileFromCommonsUrl(url) {
  // Commons image URLs end with the filename; Special:FilePath resolves it
  // at any width without storing bytes.
  try {
    const name = decodeURIComponent(String(url).split("/").pop() ?? "");
    if (!name) return null;
    return {
      file: name,
      thumb: `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=800`,
      page: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(name.replaceAll(" ", "_"))}`,
    };
  } catch {
    return null;
  }
}

async function fetchSparql() {
  const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(SPARQL)}`;
  const res = await fetch(url, { headers: { "User-Agent": "DodocoHelper-snapshot-fetcher/1.0", Accept: "application/sparql-results+json" } });
  if (!res.ok) throw new Error(`SPARQL ${res.status}`);
  return res.json();
}

function toItem(b) {
  const qid = String(b.item?.value ?? "").split("/").pop();
  const coord = coordFromWkt(b.coord?.value);
  const file = fileFromCommonsUrl(b.image?.value);
  const year = Number(String(b.inception?.value ?? "").slice(0, 4));
  if (!qid || !coord || !file || !Number.isInteger(year)) return null;
  if (!Number.isFinite(coord.lat) || !Number.isFinite(coord.lon)) return null;
  return {
    id: `wd-${qid}`,
    title: b.itemLabel?.value ?? qid,
    creator: "Unknown",
    kind: "painting",
    image: file.thumb,
    page: file.page,
    lat: Math.round(coord.lat * 1000) / 1000,
    lon: Math.round(coord.lon * 1000) / 1000,
    placeName: b.placeLabel?.value ?? "Unknown",
    year,
    license: "See Commons page",
  };
}

function loadExisting(outPath) {
  try {
    const src = fs.readFileSync(outPath, "utf8");
    const m = /SNAPSHOT_ITEMS: SnapshotItem\[\] = (\[[\s\S]*\]);\s*$/.exec(src);
    if (!m) return [];
    return JSON.parse(m[1]);
  } catch {
    return [];
  }
}

const body = await fetchSparql();
const fetched = (body.results?.bindings ?? []).map(toItem).filter(Boolean);
const existing = loadExisting(OUT);
const byId = new Map();
for (const it of [...existing, ...fetched]) {
  if (it && typeof it.id === "string" && !byId.has(it.id)) byId.set(it.id, it);
}
// Hand-curated `manual-` entries always win over fetched rows.
const merged = [...byId.values()].sort((a, b) =>
  a.id.startsWith("manual-") && !b.id.startsWith("manual-")
    ? -1
    : !a.id.startsWith("manual-") && b.id.startsWith("manual-")
      ? 1
      : String(a.id).localeCompare(String(b.id)),
);

const out = `import type { SnapshotItem } from "./types.js";\n\nexport const SNAPSHOT_ITEMS: SnapshotItem[] = ${JSON.stringify(merged, null, 2)};\n`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);
console.log(`snapshot: fetched ${fetched.length}, total ${merged.length} -> ${path.relative(ROOT, OUT)}`);
