import type { NormalizedPuzzle } from "./types.js";
import { UNKNOWN } from "./types.js";
import { buildInitialState, solveByDeduction, stateToGrid, U } from "./solver.js";

const UNASSIGNED = -1;
const MIN_REGION_SIZE = 5;
const PARTITION_ATTEMPTS = 80;

type Topology = { neighbors4: number[][]; neighbors8: number[][] };
const topologyCache = new Map<number, Topology>();

function topologyFor(n: number): Topology {
  const cached = topologyCache.get(n);
  if (cached) return cached;
  const neighbors4: number[][] = [];
  const neighbors8: number[][] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const four: number[] = [];
      const eight: number[] = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nr >= n || nc < 0 || nc >= n) continue;
          const cell = nr * n + nc;
          eight.push(cell);
          if (dr === 0 || dc === 0) four.push(cell);
        }
      }
      neighbors4.push(four);
      neighbors8.push(eight);
    }
  }
  const topology = { neighbors4, neighbors8 };
  topologyCache.set(n, topology);
  return topology;
}

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

/**
 * Grow regions from distributed seeds until their target sizes are reached.
 * Failed growth attempts are discarded; the caller retries with the same
 * seeded random stream, preserving deterministic daily boards.
 */
function growPartition(n: number, targets: number[], rand: () => number): number[] | null {
  const grid = new Array<number>(n * n).fill(UNASSIGNED);
  const counts = new Array<number>(n).fill(0);
  const topology = topologyFor(n);
  const frontiers = Array.from({ length: n }, () => new Set<number>());
  const seeds = chooseSeeds(n, n, rand);

  const addToFrontier = (region: number, cell: number) => {
    if (grid[cell] === UNASSIGNED) frontiers[region].add(cell);
  };
  const assign = (region: number, cell: number) => {
    grid[cell] = region;
    counts[region]++;
    for (const frontier of frontiers) frontier.delete(cell);
    for (const neighbor of topology.neighbors4[cell]) addToFrontier(region, neighbor);
  };

  for (let region = 0; region < n; region++) assign(region, seeds[region]);

  while (counts.some((count, region) => count < targets[region])) {
    const choices: Array<{ region: number; frontier: number[]; urgency: number }> = [];
    for (let region = 0; region < n; region++) {
      if (counts[region] >= targets[region]) continue;
      const frontier = [...frontiers[region]];
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

    let bestScore = -Infinity;
    let bestCells: number[] = [];
    for (const cell of choice.frontier) {
      let sameNeighbors = 0;
      let openNeighbors = 0;
      for (const neighbor of topology.neighbors4[cell]) {
        if (grid[neighbor] === choice.region) sameNeighbors++;
        else if (grid[neighbor] === UNASSIGNED) openNeighbors++;
      }
      const score = sameNeighbors * 4 + openNeighbors + rand() * 0.5;
      if (score > bestScore) {
        bestScore = score;
        bestCells = [cell];
      } else if (score === bestScore) {
        bestCells.push(cell);
      }
    }
    assign(choice.region, bestCells[Math.floor(rand() * bestCells.length)]);
  }

  for (let region = 0; region < n; region++) {
    if (counts[region] !== targets[region] || !isConnected(grid, n, region)) return null;
  }
  return grid;
}

/** Reject a region that cannot contain `crowns` non-touching crowns. */
function everyRegionCanHoldCrowns(grid: number[], n: number, crowns: number): boolean {
  for (let region = 0; region < n; region++) {
    const cells: number[] = [];
    for (let i = 0; i < grid.length; i++) if (grid[i] === region) cells.push(i);
    if (cells.length < crowns) return false;
    if (crowns === 1) continue;
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
 * Every region must be able to hold `crownsPerUnit` non-touching crowns.
 */
export function generateRegions(n: number, crownsPerUnit = 2, rand: () => number = Math.random): number[][] | null {
  if (n < 5) return null;

  for (let attempt = 0; attempt < PARTITION_ATTEMPTS; attempt++) {
    const targets = regionSizeProfile(n, rand);
    const grid = growPartition(n, targets, rand);
    if (!grid || !everyRegionCanHoldCrowns(grid, n, crownsPerUnit)) continue;

    const result: number[][] = [];
    for (let r = 0; r < n; r++) {
      result.push(grid.slice(r * n, (r + 1) * n));
    }
    return result;
  }
  return null;
}

function toPuzzleInput(
  regions: number[][],
  initial: string[][],
  crownsPerUnit: number,
): NormalizedPuzzle {
  const n = regions.length;
  return {
    size: n,
    crownsPerRow: crownsPerUnit,
    crownsPerColumn: crownsPerUnit,
    crownsPerRegion: crownsPerUnit,
    regions,
    regionCount: n,
    initial,
    palette: null,
  };
}

function blankInitial(size: number): string[][] {
  return Array.from({ length: size }, () => Array(size).fill(UNKNOWN) as string[]);
}

/** Run the human-deduction cascade on the empty board of a region map.
 * Generation does not need interactive step explanations, so the solver skips
 * constructing them while retaining the exact same deduction rules. */
interface CascadeScore {
  solved: boolean;
  resolved: number;
  hardest: string;
  solution?: string[][];
}

function cascadeScore(regions: number[][], crownsPerUnit: number): CascadeScore {
  const n = regions.length;
  const puzzle: NormalizedPuzzle = toPuzzleInput(regions, blankInitial(n), crownsPerUnit);
  const { state, tg } = buildInitialState(puzzle);
  const res = solveByDeduction(state, tg, false, 5000, 0, false);
  const resolved = n * n - state.grid.filter((v) => v === U).length;
  return {
    solved: res.solved,
    resolved,
    hardest: res.hardest,
    solution: res.solved ? stateToGrid(state).grid : undefined,
  };
}

function regionSize(grid: number[], id: number): number {
  let count = 0;
  for (const v of grid) if (v === id) count++;
  return count;
}

/** Move one border cell of region A into adjacent region B (both stay connected). */
function mutateRegions(regions: number[][], rand: () => number): number[][] | null {
  const n = regions.length;
  const grid = regions.flat();
  for (let t = 0; t < 24; t++) {
    const ri = Math.floor(rand() * n * n);
    const rr = Math.floor(ri / n);
    const rc = ri % n;
    const a = grid[ri];
    const neighbors = neighbors4(n, rr, rc).filter(([nr, nc]) => grid[nr * n + nc] !== a);
    if (neighbors.length === 0) continue;
    const [nr, nc] = neighbors[Math.floor(rand() * neighbors.length)];
    const b = grid[nr * n + nc];
    if (regionSize(grid, a) - 1 < MIN_REGION_SIZE) continue;
    grid[ri] = b;
    if (isConnected(grid, n, a) && isConnected(grid, n, b)) {
      const out: number[][] = [];
      for (let r = 0; r < n; r++) out.push(grid.slice(r * n, (r + 1) * n));
      return out;
    }
    grid[ri] = a;
  }
  return null;
}

/**
 * G1-style generation: grow random layouts, then keep local border mutations
 * only while they advance the blank-board deduction cascade. Accepts the first
 * layout whose EMPTY board fully solves by the human rules — the returned board
 * is never prefilled. Progress persists across fresh candidates and the search
 * budget grows with the board size; when it runs out we fail loudly rather than
 * revealing any marks.
 */
export interface GeneratedPuzzle {
  puzzle: NormalizedPuzzle;
  solution: string[][];
}

/** Generate until a blank board is completely solved by the deduction rules.
 * `maxAttempts` is retained for source compatibility but is no longer used as
 * a timeout or fallback limit: generation has no time-based failure path. */
export function generatePuzzleWithSolution(
  size = 9,
  crownsPerUnit = 2,
  _maxAttempts = 1200,
  rand: () => number = Math.random,
): GeneratedPuzzle {
  const MUTATIONS_PER_CANDIDATE = 60;

  for (;;) {
    const regions = generateRegions(size, crownsPerUnit, rand);
    if (!regions) continue;

    const base = cascadeScore(regions, crownsPerUnit);
    if (base.solved && base.solution) {
      return {
        puzzle: toPuzzleInput(regions, blankInitial(size), crownsPerUnit),
        solution: base.solution,
      };
    }

    // Climb local border mutations from this fresh candidate.
    let best = { regions, resolved: base.resolved };
    for (let m = 0; m < MUTATIONS_PER_CANDIDATE; m++) {
      const mutated = mutateRegions(best.regions, rand);
      if (!mutated) continue;
      const sc = cascadeScore(mutated, crownsPerUnit);
      if (sc.solved && sc.solution) {
        return {
          puzzle: toPuzzleInput(mutated, blankInitial(size), crownsPerUnit),
          solution: sc.solution,
        };
      }
      if (sc.resolved > best.resolved) best = { regions: mutated, resolved: sc.resolved };
    }
  }
}

/** Compatibility wrapper for callers that only need the puzzle. */
export function generatePuzzle(
  size = 9,
  crownsPerUnit = 2,
  maxAttempts = 1200,
  rand: () => number = Math.random,
): NormalizedPuzzle {
  return generatePuzzleWithSolution(size, crownsPerUnit, maxAttempts, rand).puzzle;
}
