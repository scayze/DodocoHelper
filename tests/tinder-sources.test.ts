import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  openDb, exportIdForSource, parseFileUsage, poolDecadeHistogram, poolTotal, sourceForQid,
  tinderExcludeKeys, tinderExcludedQids, tinderExport, tinderMarkServed,
  tinderPoolBySource, tinderPoolInsert, tinderPoolTakeRange, tinderVote,
} from "../server/db.js";
import { createHandler } from "../server/app.js";
import { isPinId } from "../server/sources/historypin.js";
import { acceptsSourceId, exportIdFor, sourceMode } from "../server/sources/index.js";
import { isWikidataId } from "../server/sources/wikidata/index.js";
import {
  buildBulkQuery,
  countNewCandidates,
  discoverBulk,
  DISCOVERY_DATE_PROPS,
  ensureCandidateTables,
  parseSliceRows,
  parseWktPoint,
  yearFromXsdDateTime,
} from "../server/sources/wikidata/discovery.js";
import {
  commonsLicense, pickBlurb, preferredDateClaim, usageForFile,
} from "../server/sources/wikidata/map.js";
import { thinnestPoolDecade } from "../server/sources/wikidata/worker.js";
import { dateDisplay, verbForTypes } from "../server/sources/types.js";
import { wikidataAdapter } from "../server/sources/wikidata/index.js";
import { noteSparqlCall, resetPoliteForTests, sparqlBudgetExhausted } from "../server/sources/wikidata/polite.js";
import { enrichCandidates } from "../server/sources/wikidata/enrich.js";

describe("source routing", () => {
  it("accepts hp: and wd: namespaces, rejects the rest", () => {
    assert.equal(isPinId("hp:123"), true);
    assert.equal(isWikidataId("wd:Q243"), true);
    assert.equal(acceptsSourceId("hp:123"), true);
    assert.equal(acceptsSourceId("wd:Q243"), true);
    assert.equal(acceptsSourceId("ph-Q243"), false);
    assert.equal(acceptsSourceId(""), false);
  });

  it("export ids match per-source rules", () => {
    assert.equal(exportIdFor("hp:42", 1889), "hp-42-1889");
    assert.equal(exportIdFor("wd:Q243", 1889), "wd-Q243-1889");
    assert.equal(exportIdForSource("hp:42", 1889), "hp-42-1889");
    assert.equal(exportIdForSource("wd:Q243", 1889), "wd-Q243-1889");
  });

  it("defaults to mixed mode", () => {
    delete process.env["SOURCE"];
    assert.equal(sourceMode(), "mixed");
  });
});

describe("discovery parsing", () => {
  it("parses WKT points", () => {
    assert.deepEqual(parseWktPoint("Point(2.35 48.85)"), { lat: 48.85, lon: 2.35 });
    assert.deepEqual(parseWktPoint("POINT(23.765278 61.497500)"), { lat: 61.498, lon: 23.765 });
    assert.equal(parseWktPoint("nope"), null);
    assert.equal(parseWktPoint("Point(200 100)"), null);
  });

  it("parses XSD datetimes with range guard", () => {
    assert.equal(yearFromXsdDateTime("1889-05-01T00:00:00Z"), 1889);
    assert.equal(yearFromXsdDateTime("1300-01-01T00:00:00Z"), null);
    assert.equal(yearFromXsdDateTime("garbage"), null);
  });

  it("maps SPARQL rows to candidates, deduping", () => {
    const rows = parseSliceRows({
      results: {
        bindings: [
          { item: { value: "http://www.wikidata.org/entity/Q243" }, coord: { value: "Point(2.35 48.85)" }, date: { value: "1889-05-01T00:00:00Z" } },
          { item: { value: "http://www.wikidata.org/entity/Q243" }, coord: { value: "Point(2.35 48.85)" }, date: { value: "1889-05-01T00:00:00Z" } },
          { item: { value: "http://www.wikidata.org/entity/Q1" }, coord: { value: "Point(0 0)" }, date: { value: "1300-01-01T00:00:00Z" } },
        ],
      },
    });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { qid: "wd:Q243", year: 1889, lat: 48.85, lon: 2.35 });
  });

  it("bulk query avoids RAND/OFFSET, hardfilters enwiki sitelinks", () => {
    // Discovery is event-only: P585/P580 (depicted moment), never P571.
    assert.deepEqual(DISCOVERY_DATE_PROPS, ["P585", "P580"]);
    const q = buildBulkQuery(1900, 1903, "P585", 1500);
    assert.match(q, /ORDER BY \?item/);
    assert.doesNotMatch(q, /RAND/i);
    assert.doesNotMatch(q, /OFFSET/i);
    assert.match(q, /P18/);
    assert.match(q, /P625/);
    assert.match(q, /wdt:P585/);
    assert.match(q, /PREFIX wdt:/); // QLever requires explicit prefixes
    assert.match(q, /PREFIX schema:/);
    assert.match(q, /schema:isPartOf <https:\/\/en\.wikipedia\.org\/>/);
    assert.match(q, /\^\^xsd:dateTime/); // index-friendly range, not YEAR()
    assert.match(q, /LIMIT 1500/);
    assert.match(buildBulkQuery(1900, 1903, "P580", 10), /wdt:P580/);
  });
});

describe("enrichment mapping", () => {
  it("prefers P585 over P580 over P577 over P571, earliest within each", () => {
    const bomb = { time: "+1700-00-00T00:00:00Z", precision: 9 };
    assert.deepEqual(
      preferredDateClaim([{ property: "P571", ...bomb }, { property: "P585", time: "+1905-00-00T00:00:00Z", precision: 9 }]),
      { year: 1905, property: "P585", precision: 9 },
    );
    assert.deepEqual(
      preferredDateClaim([{ property: "P571", time: "+1901-00-00T00:00:00Z", precision: 9 }, { property: "P580", ...bomb }]),
      { year: 1700, property: "P580", precision: 9 },
    );
    assert.deepEqual(
      preferredDateClaim([{ property: "P571", ...bomb }, { property: "P577", time: "+1750-00-00T00:00:00Z", precision: 9 }]),
      { year: 1750, property: "P577", precision: 9 },
    );
    // Earliest within the winning property.
    assert.deepEqual(
      preferredDateClaim([
        { property: "P585", time: "+1910-00-00T00:00:00Z", precision: 9 },
        { property: "P585", time: "+1905-05-01T00:00:00Z", precision: 11 },
      ]),
      { year: 1905, property: "P585", precision: 11 },
    );
    // Century precision never qualifies, even alone.
    assert.equal(preferredDateClaim([{ property: "P571", time: "+1800-00-00T00:00:00Z", precision: 7 }]), null);
    assert.equal(preferredDateClaim([]), null);
  });

  it("blocks restrictive Commons licenses, allows free ones", () => {
    assert.equal(commonsLicense(["CC BY-SA 4.0", "companions"]).ok, true);
    assert.equal(commonsLicense(["All rights reserved"]).ok, false);
    assert.equal(commonsLicense(["Fair use"]).ok, false);
    assert.equal(commonsLicense([]).ok, true);
  });

  it("maps inception verbs by subject type, specific first", () => {
    assert.equal(verbForTypes(JSON.stringify(["Q16970", "Q41176"])), "built");
    assert.equal(verbForTypes(JSON.stringify(["Q41176", "Q16970"])), "built"); // priority, not order
    assert.equal(verbForTypes(JSON.stringify(["Q515"])), "founded");
    assert.equal(verbForTypes(JSON.stringify(["Q3305213"])), "painted");
    assert.equal(verbForTypes(JSON.stringify(["Q125191"])), "taken");
    assert.equal(verbForTypes(JSON.stringify(["Q11424"])), "released");
    assert.equal(verbForTypes(JSON.stringify(["Q2977"])), "built");
    assert.equal(verbForTypes(JSON.stringify(["Q571"])), "written");
    assert.equal(verbForTypes(JSON.stringify(["Q11446"])), "launched");
    assert.equal(verbForTypes(JSON.stringify(["Q8502"])), "formed");
    assert.equal(verbForTypes(JSON.stringify(["Q178561"])), "fought");
    assert.equal(verbForTypes(JSON.stringify(["Q532"])), "founded");
    assert.equal(verbForTypes(JSON.stringify(["Q57831"])), "built");
    assert.equal(verbForTypes(JSON.stringify(["Q486972"])), "founded");
    assert.equal(verbForTypes(JSON.stringify(["Q192287"])), "formed");
    assert.equal(verbForTypes(JSON.stringify(["Q1088552"])), "built");
    assert.equal(verbForTypes(JSON.stringify(["Q55488"])), "opened");
    assert.equal(verbForTypes(JSON.stringify(["Q928830", "Q41176"])), "opened"); // station beats generic building
    assert.equal(verbForTypes(JSON.stringify(["Q99999999"])), null);
    assert.equal(verbForTypes(""), null);
    assert.equal(verbForTypes("garbage"), null);
    assert.deepEqual(dateDisplay("P571", JSON.stringify(["Q16970"])), {
      tag: " (built)", hint: "Subject built then — the photo itself may be newer.",
    });
    assert.deepEqual(dateDisplay("P571", JSON.stringify(["Q515"])).tag, " (founded)");
    assert.deepEqual(dateDisplay("P571", JSON.stringify(["Q125191"])), {
      tag: " (taken)", hint: "Photo taken then.",
    });
    assert.deepEqual(dateDisplay("P571", ""), {
      tag: " (inception of subject)",
      hint: "Inception: when the subject came into being — the photo itself may be newer.",
    });
    assert.equal(dateDisplay("P585", "").tag, " (date depicted)");
    assert.equal(dateDisplay("depicted", "").tag, " (photo date)");
    assert.deepEqual(dateDisplay("", ""), { tag: "", hint: "" });
    // End to end through the adapter: tag rides on the card.
    const card = wikidataAdapter.toCard({
      sourceId: "wd:Q1", title: "T", image: "http://x/i.jpg", sourceImage: "http://x/i.jpg",
      year: 1901, lat: 1, lon: 2, page: "http://x", license: "l", blurb: "b",
      dateKind: "P571", subjectTypes: JSON.stringify(["Q12518"]),
    });
    assert.equal(card.dateTag, " (built)");
    assert.ok(card.dateHint.length > 0);
  });

  it("matches globalusage pages back to requested files", () => {
    const pages = {
      "1": {
        title: "File:Eiffel test image.jpg",
        globalusage: [
          { wiki: "en.wikipedia.org", title: "Eiffel Tower", url: "https://en.wikipedia.org/wiki/Eiffel_Tower" },
          { wiki: "fr.wikipedia.org", title: "Tour Eiffel", url: "https://fr.wikipedia.org/wiki/Tour_Eiffel" },
        ],
      },
    };
    assert.equal(usageForFile(pages, "Eiffel test image.jpg").length, 2);
    assert.equal(usageForFile(pages, "Eiffel_test_image.jpg").length, 2);
    assert.deepEqual(usageForFile(pages, "other.jpg"), []);
    assert.deepEqual(parseFileUsage(null), null);
    assert.deepEqual(parseFileUsage(""), null);
    assert.equal(parseFileUsage(JSON.stringify(pages["1"]!.globalusage))!.length, 2);
    assert.equal(sourceForQid("wd:Q1"), "wikidata");
    assert.equal(sourceForQid("hp:1"), "historypin");
  });

  it("pool histogram finds thin decades", () => {
    const db = openDb(":memory:");
    tinderPoolInsert(db, [{
      qid: "hp:9", image: "http://x/9.jpg", title: "t", label: "t",
      description: "d", descLang: "en", year: 1901, lat: 1, lon: 2,
      page: "http://x", thumb: "http://x/9.jpg", license: "l",
    }]);
    const hist = poolDecadeHistogram(db);
    assert.equal(hist.length, 9);
    assert.equal(hist.reduce((a, b) => a + b, 0), 1);
    assert.equal(thinnestPoolDecade(db), 0); // empty 1700-1800 beats the 1-row 1900-1920
    assert.equal(countNewCandidates(db), 0);
    db.close();
  });

  it("provenance survives pool → seen → export", () => {
    const db = openDb(":memory:");
    tinderPoolInsert(db, [{
      qid: "wd:Q243", image: "http://x/img.jpg", title: "Tower", label: "Tower",
      description: "blurb here that is long enough", descLang: "en", year: 1889,
      lat: 48.85, lon: 2.35, page: "http://www.wikidata.org/wiki/Q243",
      thumb: "http://x/img.jpg", license: "CC BY-SA 4.0",
      source: "wikidata", dateKind: "P585", datePrecision: 11,
      article: "Eiffel Tower", fileUsage: JSON.stringify([{ wiki: "en.wikipedia.org", title: "Eiffel Tower", url: "https://en.wikipedia.org/wiki/Eiffel_Tower" }]),
      subjectTypes: JSON.stringify(["Q515"]),
      dateClaims: JSON.stringify([
        { property: "P571", time: "+1700-00-00T00:00:00Z", precision: 9 },
        { property: "P585", time: "+1889-05-01T00:00:00Z", precision: 11 },
      ]),
    }]);
    const [row] = tinderPoolTakeRange(db, 1800, 1900, 4, "wd");
    assert.equal(row!.source, "wikidata");
    assert.equal(row!.dateKind, "P585");
    // Unserved cards are unvotable; serving flags them votable.
    assert.equal(tinderVote(db, { eventQid: "wd:Q243", image: "http://x/img.jpg", rendered: "http://x/img.jpg", decision: "accepted" }), false);
    tinderMarkServed(db, [row!.image]);
    assert.equal(tinderVote(db, { eventQid: "wd:Q243", image: "http://x/img.jpg", rendered: "http://x/thumb-known-good.jpg", decision: "accepted" }), true);
    // First vote wins: re-votes fail and the pool row is retired.
    assert.equal(tinderVote(db, { eventQid: "wd:Q243", image: "http://x/img.jpg", rendered: "http://x/img.jpg", decision: "rejected" }), false);
    assert.equal(poolTotal(db), 0);
    // Decided rows are excluded at both levels; the rendered URL is kept.
    assert.ok(tinderExcludeKeys(db).has("http://x/img.jpg"));
    assert.ok(tinderExcludedQids(db).has("wd:Q243"));
    const [item] = tinderExport(db) as Array<Record<string, unknown>>;
    assert.equal(item!["id"], "wd-Q243-1889");
    assert.equal(item!["source"], "wikidata");
    assert.equal(item!["dateKind"], "P585");
    assert.equal(item!["article"], "Eiffel Tower");
    assert.equal(item!["image"], "http://x/thumb-known-good.jpg");
    assert.equal((item!["fileUsage"] as Array<{ wiki: string }>)!.length, 1);
    assert.deepEqual(item!["subjectTypes"], ["Q515"]);
    assert.deepEqual(item!["dateClaims"], [
      { property: "P571", time: "+1700-00-00T00:00:00Z", precision: 9 },
      { property: "P585", time: "+1889-05-01T00:00:00Z", precision: 11 },
    ]);
    db.close();
  });

  it("pending migration resurrects in-flight rows into the pool", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const file = join(mkdtempSync(join(tmpdir(), "tinder-mig-")) + "/", "t.db");
    const { DatabaseSync } = await import("node:sqlite");
    // Legacy-shaped DB: create via openDb, then inject a pending row raw.
    const setup = openDb(file);
    setup.prepare(
      `INSERT INTO tinder_seen(event_qid, image, title, place_name, lat, lon, year, decade, point_in_time, page, thumb, license, blurb, blurb_source, source, date_kind, date_precision, article, file_usage, translated, status)
       VALUES('hp:7', 'http://x/7.jpg', 'T', 'T', 1, 2, 1901, 1900, '1901', 'http://x', 'http://x/7.jpg', 'l', 'b', 'http://x', 'historypin', 'depicted', 0, '', '', 1, 'pending')`,
    ).run();
    setup.close();
    // Reopen: migration moves pending → pool (votable) and clears pending.
    const db = openDb(file);
    assert.equal(poolTotal(db), 1);
    const [row] = tinderPoolTakeRange(db, 1900, 1920, 4);
    assert.equal(row!.qid, "hp:7");
    assert.equal(tinderVote(db, { eventQid: "hp:7", image: "http://x/7.jpg", rendered: "http://x/7.jpg", decision: "rejected" }), true);
    assert.deepEqual(tinderExport(db, "rejected").map((i) => i["id"]), ["hp-7-1901"]);
    db.close();
  });

  it("blurb chain prefers description, then wiki extract, then label", () => {
    const long = "This is a sufficiently long Wikidata description of the place depicted here.";
    assert.equal(pickBlurb({ description: long, label: "X" }), long);
    const ext = "First sentence here with enough detail to pass. Second sentence follows with more. Third is extra.";
    const picked = pickBlurb({ description: "tiny", wikiExtract: ext, label: "X" });
    assert.ok(picked && picked.includes("First sentence"));
    assert.equal(pickBlurb({ label: "Only label" }), "Only label");
    assert.equal(pickBlurb({}), null);
  });
});

describe("tinder ?source= filter", () => {
  // Serving is pure DB (all harvest runs in background workers), so these
  // need no network stubbing and are fully deterministic.
  function seedMixed() {
    const db = openDb(":memory:");
    tinderPoolInsert(db, [
      {
        qid: "hp:1", image: "http://x/hp.jpg", title: "hp", label: "hp",
        description: "hp blurb that is long enough to keep", descLang: "en", year: 1901,
        lat: 1, lon: 2, page: "http://x/hp", thumb: "http://x/hp.jpg", license: "l",
      },
      {
        qid: "wd:Q1", image: "http://x/wd.jpg", title: "wd", label: "wd",
        description: "wd blurb that is long enough to keep", descLang: "en", year: 1901,
        lat: 3, lon: 4, page: "http://x/wd", thumb: "http://x/wd.jpg", license: "l",
      },
    ]);
    return db;
  }

  function fakeReq(url: string) {
    const stream = new Readable({ read() {} });
    Object.assign(stream, { url, method: "GET", headers: {}, socket: { remoteAddress: "127.0.0.1" } });
    process.nextTick(() => stream.push(null));
    return stream;
  }

  function get(handler: (req: never, res: never) => Promise<void>, url: string): Promise<{ status: number; json: { cards?: Array<{ pinId: string }> } }> {
    return new Promise((resolve, reject) => {
      const res = {
        writeHead(status: number) { (res as { status?: number }).status = status; },
        end(data?: string) {
          try {
            resolve({ status: (res as { status?: number }).status ?? 0, json: JSON.parse(String(data ?? "")) });
          } catch (e) { reject(e); }
        },
      };
      void handler(fakeReq(url) as never, res as never).catch(reject);
    });
  }

  it("serves only the requested source", async () => {
    for (const [param, want] of [["wd", ["wd:Q1"]], ["wikidata", ["wd:Q1"]], ["hp", ["hp:1"]], ["historypin", ["hp:1"]]] as Array<[string, string[]]>) {
      const db = seedMixed();
      const res = await get(createHandler(db), `/api/tinder/next?limit=1&source=${param}`);
      assert.equal(res.status, 200);
      assert.deepEqual((res.json.cards ?? []).map((c) => c.pinId), want);
      db.close();
    }
  });

  it("mixes decades within one response", async () => {
    const db = openDb(":memory:");
    tinderPoolInsert(db, [1820, 1910, 1955, 2005].map((year, i) => ({
      qid: `hp:${10 + i}`, image: `http://x/${10 + i}.jpg`, title: `t${i}`, label: `t${i}`,
      description: "blurb here that is long enough", descLang: "en", year, lat: 1, lon: 2,
      page: "http://x", thumb: `http://x/${10 + i}.jpg`, license: "l",
    })));
    const res = await get(createHandler(db), "/api/tinder/next?limit=4");
    assert.equal(res.status, 200);
    assert.deepEqual(
      ((res.json.cards ?? []).map((c) => (c as { pinId: string }).pinId)).sort(),
      ["hp:10", "hp:11", "hp:12", "hp:13"],
    );
    db.close();
  });

  it("serves both sources without a filter", async () => {
    const db = seedMixed();
    const res = await get(createHandler(db), "/api/tinder/next?limit=2");
    assert.equal(res.status, 200);
    assert.deepEqual(((res.json.cards ?? []).map((c) => c.pinId)).sort(), ["hp:1", "wd:Q1"]);
    db.close();
  });
});

describe("enrichment hardfilter", () => {
  async function enrichOne(qid: string, entity: unknown): Promise<{ inserted: number; dead: number }> {
    resetPoliteForTests();
    const db = openDb(":memory:");
    ensureCandidateTables(db);
    db.prepare(`INSERT INTO wd_candidates(qid, year, lat, lon, bucket) VALUES(?, 1901, 1, 2, 1900)`).run(qid);
    const origFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: unknown) => {
      const u = String(url);
      const json = async (): Promise<unknown> => {
        if (u.includes("/w/api.php") && u.includes("wbgetentities")) return { entities: { [qid.replace(/^wd:/, "")]: entity } };
        if (u.includes("commons.wikimedia.org")) {
          return {
            query: { pages: { "1": { title: "File:Test.jpg", imageinfo: [{ url: "http://x/test.jpg", thumburl: "http://x/test-thumb.jpg", extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" } } }], globalusage: [] } } },
          };
        }
        throw new Error(`unexpected fetch: ${u.slice(0, 80)}`);
      };
      return { ok: true, status: 200, headers: new Headers(), json, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    }) as typeof fetch;
    try {
      return await enrichCandidates(db, 10);
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch;
      resetPoliteForTests();
      db.close();
    }
  }

  const base = {
    labels: { en: { value: "Some old place with a long enough label here" } },
    descriptions: { en: { value: "A sufficiently long description of this place for blurb use here." } },
    sitelinks: { enwiki: { title: "Some Place" } },
    claims: {
      P18: [{ mainsnak: { datavalue: { value: "Test.jpg" } } }],
      P625: [{ mainsnak: { datavalue: { value: { latitude: 1, longitude: 2 } } } }],
      P571: [{ mainsnak: { datavalue: { value: { time: "+1901-00-00T00:00:00Z", precision: 9 } } } }],
    },
  };

  it("enriches articled, year-dated items", async () => {
    assert.deepEqual(await enrichOne("wd:Q1", base), { inserted: 1, dead: 0 });
  });

  it("kills items without a live English article", async () => {
    const noArticle = { ...base, sitelinks: {} };
    assert.deepEqual(await enrichOne("wd:Q2", noArticle), { inserted: 0, dead: 1 });
  });

  it("kills items with only century-precision dates", async () => {
    const century = {
      ...base,
      claims: {
        ...base.claims,
        P571: [{ mainsnak: { datavalue: { value: { time: "+1900-00-00T00:00:00Z", precision: 7 } } } }],
      },
    };
    assert.deepEqual(await enrichOne("wd:Q3", century), { inserted: 0, dead: 1 });
  });
});

describe("sparql budget", () => {
  it("exhausts after the daily budget", () => {
    const db = openDb(":memory:");
    assert.equal(sparqlBudgetExhausted(db, 2), false);
    noteSparqlCall(db, 10, true);
    noteSparqlCall(db, 10, true);
    assert.equal(sparqlBudgetExhausted(db, 2), true);
    db.close();
  });
});

describe("wikidata worker cycle (mocked network)", () => {
  it("discovers slices and enriches into tinder_pool", async () => {
    resetPoliteForTests();
    const db = openDb(":memory:");
    ensureCandidateTables(db);
    const origFetch = globalThis.fetch;
    const sparqlBody = {
      results: {
        bindings: [
          { item: { value: "http://www.wikidata.org/entity/Q243" }, coord: { value: "Point(2.35 48.85)" }, date: { value: "1889-05-01T00:00:00Z" } },
        ],
      },
    };
    const entitiesBody = {
      entities: {
        Q243: {
          labels: { en: { value: "Eiffel Tower construction" } },
          descriptions: { en: { value: "Photograph of the Eiffel Tower under construction in Paris in 1889, showing workers." } },
          sitelinks: { enwiki: { title: "Eiffel Tower" } },
          claims: {
            P18: [{ mainsnak: { datavalue: { value: "Eiffel test image.jpg" } } }],
            P625: [{ mainsnak: { datavalue: { value: { latitude: 48.858, longitude: 2.294 } } } }],
            P571: [{ mainsnak: { datavalue: { value: { time: "+1889-00-00T00:00:00Z", precision: 9 } } } }],
            P31: [{ mainsnak: { datavalue: { value: { id: "Q16970" } } } }],
          },
        },
      },
    };
    const commonsBody = {
      query: {
        pages: {
          "1": {
            imageinfo: [{
              url: "https://upload.wikimedia.org/wikipedia/commons/Eiffel_test_image.jpg",
              thumburl: "https://upload.wikimedia.org/wikipedia/commons/thumb/Eiffel_test_image.jpg/1000px-Eiffel_test_image.jpg",
              extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" }, UsageTerms: { value: "free" } },
            }],
          },
        },
      },
    };
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: unknown) => {
      const u = String(url);
      const json = async (): Promise<unknown> => {
        if (u.includes("wikidata.org/sparql") || u.includes("qlever.dev")) return sparqlBody;
        if (u.includes("www.wikidata.org/w/api.php")) return entitiesBody;
        if (u.includes("commons.wikimedia.org")) return commonsBody;
        throw new Error(`unexpected fetch: ${u.slice(0, 80)}`);
      };
      return { ok: true, status: 200, headers: new Headers(), json, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    }) as typeof fetch;
    try {
      const n = await discoverBulk(db, 1889, 1892, 50);
      assert.equal(n, 1); // same QID across 4 props → INSERT OR IGNORE dedupes
      const res = await enrichCandidates(db, 10);
      assert.equal(res.inserted, 1);
      assert.deepEqual(tinderPoolBySource(db), { historypin: 0, wikidata: 1 });
      const [only] = tinderPoolTakeRange(db, 1800, 1900, 4, "wd");
      assert.equal(only!.dateKind, "P571");
      assert.equal(only!.article, "Eiffel Tower");
      assert.deepEqual(JSON.parse(only!.subjectTypes!), ["Q16970"]);
      // Mixed-source pool insert still works alongside.
      tinderPoolInsert(db, [{
        qid: "hp:1", image: "http://x/y.jpg", title: "t", label: "t",
        description: "d", descLang: "en", year: 1901, lat: 1, lon: 2,
        page: "http://x", thumb: "http://x/y.jpg", license: "l",
      }]);
      assert.deepEqual(tinderPoolBySource(db), { historypin: 1, wikidata: 1 });
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch;
      resetPoliteForTests();
      db.close();
    }
  });
});
