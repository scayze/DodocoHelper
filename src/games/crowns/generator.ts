import type { NormalizedPuzzle } from "./types.js";
import { UNKNOWN } from "./types.js";
import { solveAll } from "./solver.js";

const UNASSIGNED = -1;
const MIN_REGION_SIZE = 5;
const PARTITION_ATTEMPTS = 80;

function idx(n: number, r: number, c: number): number {
  return r * n + c;
}

function neighbors4(n: number, r: number, c: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const nr = r + dr;
    const nc = c + dc;
    if (nr >= 0 && nr < n && nc >= 0 && nc < n) out.push([nr, nc]);
  }
  return out;
}

function shuffle<T>(values: T[], rand: () => number): T[] {
  const out = values.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Check if a region is connected via BFS. */
function isConnected(grid: number[], n: number, regionId: number): boolean {
  const total = n * n;
  let start = -1;
  for (let i = 0; i < total; i++) {
    if (grid[i] === regionId) {
      start = i;
      break;
    }
  }
  if (start === -1) return false;

  const visited = new Set<number>([start]);
  const queue = [start];
  let count = 0;
  while (queue.length > 0) {
    const u = queue.shift()!;
    count++;
    const ur = Math.floor(u / n);
    const uc = u % n;
    for (const [nr, nc] of neighbors4(n, ur, uc)) {
      const v = idx(n, nr, nc);
      if (!visited.has(v) && grid[v] === regionId) {
        visited.add(v);
        queue.push(v);
      }
    }
  }

  let totalCells = 0;
  for (const value of grid) if (value === regionId) totalCells++;
  return count === totalCells;
}

function regionCounts(grid: number[], regionCount: number): number[] {
  const counts = new Array<number>(regionCount).fill(0);
  for (const region of grid) {
    if (region >= 0 && region < regionCount) counts[region]++;
  }
  return counts;
}

/**
 * Build a bounded, shuffled size profile. A few regions are deliberately
 * smaller than the board width; the remaining cells are distributed to the
 * other regions. This gives early region constraints without making tiny
 * regions that cannot hold two non-adjacent crowns.
 */
function regionSizeProfile(n: number, rand: () => number): number[] {
  const regionCount = n;
  const minSize = Math.min(MIN_REGION_SIZE, n);
  const smallCount = n >= 7 ? Math.max(2, Math.floor(n / 3)) : n >= 6 ? 2 : 0;
  const sizes = new Array<number>(regionCount).fill(n);
  let deficit = 0;

  for (let i = 0; i < smallCount; i++) {
    const smallSize = Math.min(n, minSize + Math.floor(rand() * 2));
    sizes[i] = smallSize;
    deficit += n - smallSize;
  }

  const maxSize = n + Math.max(2, Math.ceil(n / 2));
  while (deficit > 0) {
    const eligible = [] as number[];
    for (let i = smallCount; i < regionCount; i++) {
      if (sizes[i] < maxSize) eligible.push(i);
    }
    if (eligible.length === 0) {
      // This is only reachable for unusually small boards. Keep the profile
      // valid rather than failing generation because of the soft upper bound.
      const fallback = smallCount < regionCount ? smallCount : 0;
      sizes[fallback]++;
      deficit--;
      continue;
    }
    const region = eligible[Math.floor(rand() * eligible.length)];
    sizes[region]++;
    deficit--;
  }

  return shuffle(sizes, rand);
}

function cellDistance(n: number, a: number, b: number): number {
  const ar = Math.floor(a / n);
  const ac = a % n;
  const br = Math.floor(b / n);
  const bc = b % n;
  return Math.abs(ar - br) + Math.abs(ac - bc);
}

/** Pick spatially distributed seeds so regions do not all start in one area. */
function chooseSeeds(n: number, regionCount: number, rand: () => number): number[] {
  const cells = Array.from({ length: n * n }, (_, i) => i);
  const seeds = [cells.splice(Math.floor(rand() * cells.length), 1)[0]];

  while (seeds.length < regionCount) {
    let bestDistance = -1;
    const best: number[] = [];
    for (const cell of cells) {
      const distance = Math.min(...seeds.map((seed) => cellDistance(n, cell, seed)));
      if (distance > bestDistance) {
        bestDistance = distance;
        best.length = 0;
        best.push(cell);
      } else if (distance === bestDistance) {
        best.push(cell);
      }
    }
    const chosen = best[Math.floor(rand() * best.length)];
    seeds.push(chosen);
    cells.splice(cells.indexOf(chosen), 1);
  }
  return seeds;
}

function frontierFor(grid: number[], n: number, regionId: number): number[] {
  const frontier: number[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const cell = idx(n, r, c);
      if (grid[cell] !== UNASSIGNED) continue;
      if (neighbors4(n, r, c).some(([nr, nc]) => grid[idx(n, nr, nc)] === regionId)) {
        frontier.push(cell);
      }
    }
  }
  return frontier;
}

/**
 * Grow regions from distributed seeds until their target sizes are reached.
 * Failed growth attempts are discarded; the caller retries with the same
 * seeded random stream, preserving deterministic daily boards.
 */
function growPartition(n: number, targets: number[], rand: () => number): number[] | null {
  const grid = new Array<number>(n * n).fill(UNASSIGNED);
  const counts = new Array<number>(n).fill(0);
  const seeds = chooseSeeds(n, n, rand);
  for (let region = 0; region < n; region++) {
    grid[seeds[region]] = region;
    counts[region] = 1;
  }

  while (counts.some((count, region) => count < targets[region])) {
    const choices: Array<{ region: number; frontier: number[]; urgency: number }> = [];
    for (let region = 0; region < n; region++) {
      if (counts[region] >= targets[region]) continue;
      const frontier = frontierFor(grid, n, region);
      if (frontier.length > 0) {
        choices.push({
          region,
          frontier,
          urgency: (targets[region] - counts[region]) / targets[region],
        });
      }
    }
    if (choices.length === 0) return null;

    const maxUrgency = Math.max(...choices.map((choice) => choice.urgency));
    const urgent = choices.filter((choice) => choice.urgency >= maxUrgency - 0.08);
    const choice = urgent[Math.floor(rand() * urgent.length)];

    // Prefer cells that keep the region compact while retaining open frontier
    // cells. Random tie-breaking keeps equal seeds reproducible but varied.
    let bestScore = -Infinity;
    let bestCells: number[] = [];
    for (const cell of choice.frontier) {
      const r = Math.floor(cell / n);
      const c = cell % n;
      const sameNeighbors = neighbors4(n, r, c).filter(
        ([nr, nc]) => grid[idx(n, nr, nc)] === choice.region,
      ).length;
      const openNeighbors = neighbors4(n, r, c).filter(
        ([nr, nc]) => grid[idx(n, nr, nc)] === UNASSIGNED,
      ).length;
      const score = sameNeighbors * 4 + openNeighbors + rand() * 0.5;
      if (score > bestScore) {
        bestScore = score;
        bestCells = [cell];
      } else if (score === bestScore) {
        bestCells.push(cell);
      }
    }
    const selected = bestCells[Math.floor(rand() * bestCells.length)];
    grid[selected] = choice.region;
    counts[choice.region]++;
  }

  const actual = regionCounts(grid, n);
  if (actual.some((count, region) => count !== targets[region])) return null;
  for (let region = 0; region < n; region++) {
    if (!isConnected(grid, n, region)) return null;
  }
  return grid;
}

/** Reject a region that cannot contain two non-touching crowns. */
function everyRegionCanHoldTwoCrowns(grid: number[], n: number): boolean {
  for (let region = 0; region < n; region++) {
    const cells: number[] = [];
    for (let i = 0; i < grid.length; i++) if (grid[i] === region) cells.push(i);
    let pairFound = false;
    for (let i = 0; i < cells.length && !pairFound; i++) {
      const ar = Math.floor(cells[i] / n);
      const ac = cells[i] % n;
      for (let j = i + 1; j < cells.length; j++) {
        const br = Math.floor(cells[j] / n);
        const bc = cells[j] % n;
        if (Math.max(Math.abs(ar - br), Math.abs(ac - bc)) > 1) {
          pairFound = true;
          break;
        }
      }
    }
    if (!pairFound) return false;
  }
  return true;
}

/**
 * Generate random connected regions with deliberately varied sizes.
 * The returned labels always contain exactly `n` regions and `n*n` cells.
 */
function generateRegions(n: number, rand: () => number = Math.random): number[][] | null {
  if (n < 5) return null;

  for (let attempt = 0; attempt < PARTITION_ATTEMPTS; attempt++) {
    const targets = regionSizeProfile(n, rand);
    const grid = growPartition(n, targets, rand);
    if (!grid || !everyRegionCanHoldTwoCrowns(grid, n)) continue;

    const result: number[][] = [];
    for (let r = 0; r < n; r++) {
      result.push(grid.slice(r * n, (r + 1) * n));
    }
    return result;
  }
  return null;
}

/**
 * Generate a random valid Crown Puzzle. Pass `rand` (e.g. a seeded PRNG
 * from the daily seed) for a reproducible board.
 */
export function generatePuzzle(
  size = 9,
  crownsPerUnit = 2,
  maxAttempts = 50,
  rand: () => number = Math.random,
): NormalizedPuzzle {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const regions = generateRegions(size, rand);
    if (!regions) continue;

    const puzzle: NormalizedPuzzle = {
      size,
      crownsPerRow: crownsPerUnit,
      crownsPerColumn: crownsPerUnit,
      crownsPerRegion: crownsPerUnit,
      regions,
      regionCount: size,
      initial: Array.from({ length: size }, () => Array(size).fill(UNKNOWN)),
      palette: null,
    };

    const solutions = solveAll(puzzle, { limit: 1 });
    if (solutions.length > 0) {
      return puzzle;
    }
  }

  throw new Error(`Failed to generate a solvable puzzle after ${maxAttempts} attempts`);
}
