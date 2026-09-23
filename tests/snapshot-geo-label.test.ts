import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { answerPlace, detailAnswerLine, geoLabel, resultMissLine, resultPlaceLine } from "../src/games/snapshot/geo-label.js";

describe("snapshot geoLabel", () => {
  it("renders city + country", () => {
    assert.equal(geoLabel({ geoCity: "Paris", geoCountryName: "France" }), "Paris, France");
  });
  it("falls back to city alone", () => {
    assert.equal(geoLabel({ geoCity: "Paris" }), "Paris");
  });
  it("names oceans via locality", () => {
    assert.equal(geoLabel({ geoLocality: "Atlantic Ocean" }), "Atlantic Ocean");
  });
  it("uses subdivision + country when city is missing", () => {
    assert.equal(
      geoLabel({ geoSubdivision: "Saha, Respublika", geoCountryName: "Russian Federation" }),
      "Saha, Respublika, Russian Federation",
    );
  });
  it("returns '' when unenriched", () => {
    assert.equal(geoLabel({}), "");
  });
});

describe("snapshot detailAnswerLine", () => {
  it("shows address + year only", () => {
    assert.equal(
      detailAnswerLine({ title: "Eiffel Tower", year: 1889, placeName: "Eiffel Tower", geoCity: "Paris", geoCountryName: "France" }),
      "Paris, France, 1889",
    );
  });
  it("falls back to placeName when unenriched", () => {
    assert.equal(
      detailAnswerLine({ title: "Eiffel Tower", year: 1889, placeName: "Champ de Mars" }),
      "Champ de Mars, 1889",
    );
  });
  it("shows just the year when placeName duplicates the title", () => {
    assert.equal(detailAnswerLine({ title: "Paris", year: 1900, placeName: "Paris" }), "1900");
  });
});
describe("snapshot result rows", () => {
  const item = { placeName: "Eiffel Tower", year: 1889, geoCity: "Paris", geoCountryName: "France" };
  it("miss row shows distances only", () => {
    assert.equal(resultMissLine(312, -20), "312 km off · 20 y early");
    assert.equal(resultMissLine(50, 5), "50 km off · 5 y late");
    assert.equal(resultMissLine(0.01, 0), "spot on · exact year");
  });
  it("place row shows location & year without title", () => {
    assert.equal(resultPlaceLine(item), "Paris, France, 1889");
    assert.equal(resultPlaceLine({ placeName: "Champ de Mars", year: 1889 }), "Champ de Mars, 1889");
  });
});

describe("snapshot answerPlace", () => {
  it("appends geo to the curated name", () => {
    assert.equal(
      answerPlace({ placeName: "Eiffel Tower", geoCity: "Paris", geoCountryName: "France" }),
      "Eiffel Tower — Paris, France",
    );
  });
  it("falls back to placeName", () => {
    assert.equal(answerPlace({ placeName: "Eiffel Tower" }), "Eiffel Tower");
  });
  it("avoids stutter when identical", () => {
    assert.equal(answerPlace({ placeName: "Paris", geoCity: "Paris", geoCountryName: "France" }), "Paris, France");
  });
});
