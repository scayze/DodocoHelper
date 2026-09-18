/** Snapshot scoring: 50 pts location + 50 pts year (leaderboard 0..100).
 *
 * Location decays exponentially with great-circle distance; year decays
 * exponentially with absolute error. Both are forgiving up close and harsh
 * far away, so a decent guess still scores.
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

/** 0..50 from distance. ~150km still ~45, ~2000km ~18, 10000km+ ~0. */
export function locationScore(distKm: number): number {
  if (!Number.isFinite(distKm) || distKm < 0) return 0;
  return Math.max(0, Math.min(50, Math.round(50 * Math.exp(-distKm / 2000))));
}

/** 0..50 from year error. Exact 50, ±10y ~44, ±50y ~26, ±200y ~3. */
export function yearScore(yearErr: number): number {
  const e = Math.abs(yearErr);
  if (!Number.isFinite(e)) return 0;
  return Math.max(0, Math.min(50, Math.round(50 * Math.exp(-e / 75))));
}

/** Combined 0..100 leaderboard score. */
export function totalScore(distKm: number, yearErr: number): number {
  return locationScore(distKm) + yearScore(yearErr);
}

export function formatDistance(km: number): string {
  if (!Number.isFinite(km)) return "—";
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${Math.round(km)} km`;
  return `${Math.round(km).toLocaleString("en-US")} km`;
}
