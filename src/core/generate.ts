import type { NormalizedPuzzle } from "./types.js";
import { UNKNOWN } from "./types.js";
import { solveAll } from "./solver.js";

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

/** Check if a region is connected via BFS */
function isConnected(grid: number[], n: number, regionId: number): boolean {
  const total = n * n;
  let start = -1;
  for (let i = 0; i < total; i++) {
    if (grid[i] === regionId) { start = i; break; }
  }
  if (start === -1) return false;

  const visited = new Set<number>();
  const queue = [start];
  visited.add(start);
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
  for (let i = 0; i < total; i++) {
    if (grid[i] === regionId) totalCells++;
  }
  return count === totalCells;
}

/**
 * Generate random connected regions of equal size by perturbing a regular grid.
 *
 * 1. Start with a sqrt(N) x sqrt(N) grid of sqrt(N) x sqrt(N) blocks
 * 2. Randomly move boundary cells between adjacent region pairs, maintaining:
 *    - Both regions remain connected
 *    - Both regions remain exactly size N
 * 3. Repeat for many rounds to randomize the layout
 */
function generateRegions(n: number): number[][] | null {
  const total = n * n;
  const side = Math.round(Math.sqrt(n));

  if (side * side !== n) return null;

  // Initialize with regular blocks
  const grid = new Array<number>(total);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const br = Math.floor(r / side);
      const bc = Math.floor(c / side);
      grid[idx(n, r, c)] = br * side + bc;
    }
  }

  // Many rounds of boundary cell swaps between adjacent regions
  const rounds = n * n * 20;
  for (let s = 0; s < rounds; s++) {
    // Pick a random cell
    const r = Math.floor(Math.random() * n);
    const c = Math.floor(Math.random() * n);
    const u = idx(n, r, c);
    const regU = grid[u];

    // Find a neighbor in a different region
    const nbrs = neighbors4(n, r, c);
    const diffNbrs = nbrs.filter(([nr, nc]) => grid[idx(n, nr, nc)] !== regU);
    if (diffNbrs.length === 0) continue;
    const [nr, nc] = diffNbrs[Math.floor(Math.random() * diffNbrs.length)];
    const v = idx(n, nr, nc);
    const regV = grid[v];

    // Find another cell in regV that borders regU (not v itself)
    // and another cell in regU that borders regV (not u itself)
    // This avoids the "straight-line swap" disconnection problem
    const regUBorder: number[] = [];
    const regVBorder: number[] = [];
    for (let i = 0; i < total; i++) {
      if (grid[i] !== regU || i === u) continue;
      const ir = Math.floor(i / n);
      const ic = i % n;
      for (const [nr2, nc2] of neighbors4(n, ir, ic)) {
        if (grid[idx(n, nr2, nc2)] === regV) { regUBorder.push(i); break; }
      }
    }
    for (let i = 0; i < total; i++) {
      if (grid[i] !== regV || i === v) continue;
      const ir = Math.floor(i / n);
      const ic = i % n;
      for (const [nr2, nc2] of neighbors4(n, ir, ic)) {
        if (grid[idx(n, nr2, nc2)] === regU) { regVBorder.push(i); break; }
      }
    }

    if (regUBorder.length === 0 || regVBorder.length === 0) continue;

    // Pick random boundary cells from each region
    const swapU = regUBorder[Math.floor(Math.random() * regUBorder.length)];
    const swapV = regVBorder[Math.floor(Math.random() * regVBorder.length)];

    // Try the swap
    grid[swapU] = regV;
    grid[swapV] = regU;

    if (!isConnected(grid, n, regU) || !isConnected(grid, n, regV)) {
      // Revert
      grid[swapU] = regU;
      grid[swapV] = regV;
    }
  }

  // Verify all regions are size N
  const sizes = new Array<number>(n).fill(0);
  for (let i = 0; i < total; i++) sizes[grid[i]]++;
  for (let i = 0; i < n; i++) {
    if (sizes[i] !== n) return null;
  }

  const result: number[][] = [];
  for (let r = 0; r < n; r++) {
    const row: number[] = [];
    for (let c = 0; c < n; c++) row.push(grid[idx(n, r, c)]);
    result.push(row);
  }
  return result;
}

/**
 * Generate a random valid Crown Puzzle.
 */
export function generatePuzzle(
  size = 9,
  crownsPerUnit = 2,
  maxAttempts = 50,
): NormalizedPuzzle {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const regions = generateRegions(size);
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
