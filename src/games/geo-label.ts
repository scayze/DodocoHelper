/** Shared reverse-geocode display label ("City, Country").
 *
 * Pure helper used by Snapshot results and the Tinder curator card.
 * Takes the BigDataCloud-style fields; all optional ('' = unenriched).
 */

export interface GeoLabelFields {
  geoCity?: string | null;
  geoLocality?: string | null;
  geoSubdivision?: string | null;
  geoCountryName?: string | null;
}

function clean(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** "City, Country" chain with graceful fallbacks:
 *  city+country → "Paris, France"; city only; locality (oceans:
 *  "Atlantic Ocean"); subdivision; country; '' when unenriched. */
export function geoLabel(item: GeoLabelFields): string {
  const city = clean(item.geoCity);
  const locality = clean(item.geoLocality);
  const subdivision = clean(item.geoSubdivision);
  const country = clean(item.geoCountryName);
  if (city && country) return `${city}, ${country}`;
  if (city) return city;
  // No city and no country: oceans/remote land name the locality.
  if (locality && !country) return locality;
  if (subdivision && country) return `${subdivision}, ${country}`;
  if (subdivision) return subdivision;
  if (country) return country;
  if (locality) return locality;
  return "";
}
