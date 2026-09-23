/** Snapshot scoring: 50 pts location + 50 pts year (leaderboard 0..100).
 *
 * Location uses a flat 50 under 500 m, then exponential interpolation
 * between fixed distance anchors — steep up close, long tail far away.
 * Year decays exponentially with absolute error, but the scale (tau)
 * depends on the answer's era: modern photos are judged strictly
 * (10 y off scores 40), older works get wider tolerance.
 */

export function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Distance anchors [km, score]: full marks under 500 m, 45 at 50 km,
 *  37 at 500 km, then a long tail to 0 at the antipode. */
const LOCATION_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [0.5, 50],
  [50, 45],
  [500, 37],
  [2000, 22],
  [5000, 8],
  [10000, 2],
  [20000, 0],
];

/** 0..50 from distance. ≤0.5 km → 50, 50 km → 45, 500 km → 37,
 *  2000 km → 22, 5000 km → 8, 10000 km → 2, antipode → 0. */
export function locationScore(distKm: number): number {
  if (!Number.isFinite(distKm) || distKm < 0) return 0;
  const anchors = LOCATION_ANCHORS;
  if (distKm <= anchors[0]![0]) return 50;
  for (let i = 1; i < anchors.length; i++) {
    const [d1, s1] = anchors[i]!;
    if (distKm <= d1) {
      const [d0, s0] = anchors[i - 1]!;
      if (s1 === 50) return 50;
      const t = (distKm - d0) / (d1 - d0);
      let raw: number;
      if (s1 <= 0) {
        // Final segment decays toward 0.25 so it rounds to 0 at the end.
        raw = s0 * Math.exp(-t * Math.log(s0 / 0.25));
      } else {
        raw = s0 * Math.pow(s1 / s0, t);
      }
      return Math.max(0, Math.min(50, Math.round(raw)));
    }
  }
  return 0;
}

/** Year-error scale in years: 45 for 1900+, widening the further back
 *  (e.g. 135 at 1780), capped at 400. Keyed on the answer year so the
 *  tolerance can't be gamed via the guess. */
export function yearTau(trueYear: number): number {
  if (!Number.isFinite(trueYear) || trueYear >= 1900) return 45;
  return Math.min(400, 45 + 0.75 * (1900 - trueYear));
}

/** 0..50 from year error. Modern (tau 45): exact 50, ±10 y 40, ±50 y 16,
 *  ±100 y 5. At 1780 (tau 135): ±10 y 46, ±30 y 40, ±100 y 24. */
export function yearScore(yearErr: number, trueYear = 1900): number {
  const e = Math.abs(yearErr);
  if (!Number.isFinite(e)) return 0;
  const tau = yearTau(trueYear);
  return Math.max(0, Math.min(50, Math.round(50 * Math.exp(-e / tau))));
}

/** Combined 0..100 leaderboard score. Pass the answer year so the
 *  year tolerance scales with the era. */
export function totalScore(distKm: number, yearErr: number, trueYear = 1900): number {
  return locationScore(distKm) + yearScore(yearErr, trueYear);
}

export function formatDistance(km: number): string {
  if (!Number.isFinite(km)) return "—";
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${Math.round(km)} km`;
  return `${Math.round(km).toLocaleString("en-US")} km`;
}
