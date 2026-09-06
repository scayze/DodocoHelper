import type { NormalizedPuzzle } from "./types.js";
import { CROWN, EMPTY, UNKNOWN } from "./types.js";

export interface InputCheck {
  errors: string[];
  puzzle: NormalizedPuzzle | null;
}

function isInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x);
}

/** Validate raw JSON input; return normalized puzzle or errors. */
export function validatePuzzleInput(raw: unknown): InputCheck {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) {
    return { errors: ["input must be a JSON object"], puzzle: null };
  }
  const o = raw as Record<string, unknown>;

  const size = o.size === undefined ? 9 : o.size;
  if (!isInt(size) || size < 1 || size > 25) {
    errors.push(`"size" must be an integer 1..25 (got ${JSON.stringify(o.size)})`);
  }
  const n = size as number;

  const crownsPerRow = o.crownsPerRow === undefined ? 2 : o.crownsPerRow;
  const crownsPerColumn = o.crownsPerColumn === undefined ? 2 : o.crownsPerColumn;
  const crownsPerRegion = o.crownsPerRegion === undefined ? 2 : o.crownsPerRegion;
  for (const [name, v] of [
    ["crownsPerRow", crownsPerRow],
    ["crownsPerColumn", crownsPerColumn],
    ["crownsPerRegion", crownsPerRegion],
  ] as const) {
    if (!isInt(v) || (v as number) < 1 || (v as number) > n) {
      errors.push(`"${name}" must be an integer 1..${n} (got ${JSON.stringify(v)})`);
    }
  }

  // regions: must be n x n ints forming exactly n distinct ids 0..n-1
  let regions: number[][] | null = null;
  if (!Array.isArray(o.regions)) {
    errors.push('"regions" must be an array of arrays');
  } else if ((o.regions as unknown[]).length !== n) {
    errors.push(`"regions" must have ${n} rows (got ${(o.regions as unknown[]).length})`);
  } else {
    const seen = new Set<number>();
    let ok = true;
    const grid: number[][] = [];
    for (let r = 0; r < n; r++) {
      const row = (o.regions as unknown[])[r];
      if (!Array.isArray(row) || row.length !== n) {
        errors.push(`"regions"[${r}] must be an array of ${n} integers`);
        ok = false;
        break;
      }
      const out: number[] = [];
      for (let c = 0; c < n; c++) {
        const v = (row as unknown[])[c];
        if (!isInt(v) || v < 0 || v >= n) {
          errors.push(`"regions"[${r}][${c}] must be an integer 0..${n - 1}`);
          ok = false;
          break;
        }
        seen.add(v);
        out.push(v);
      }
      if (!ok) break;
      grid.push(out);
    }
    if (ok) {
      if (seen.size !== n) {
        errors.push(`"regions" must contain exactly ${n} distinct region ids (got ${seen.size})`);
      } else {
        for (let i = 0; i < n; i++) {
          if (!seen.has(i)) {
            errors.push(`"regions" must use exactly the ids 0..${n - 1} (missing ${i})`);
            break;
          }
        }
      }
      regions = grid;
    }
  }

  // initial: optional n x n of "?", "C", ".", "X" (normalized: x->".", lower->upper)
  let initial: string[][] | null = null;
  if (o.initial === undefined) {
    initial = Array.from({ length: n }, () => Array(n).fill(UNKNOWN));
  } else if (!Array.isArray(o.initial)) {
    errors.push('"initial" must be an array of arrays');
  } else if ((o.initial as unknown[]).length !== n) {
    errors.push(`"initial" must have ${n} rows (got ${(o.initial as unknown[]).length})`);
  } else {
    const grid: string[][] = [];
    let ok = true;
    for (let r = 0; r < n; r++) {
      const row = (o.initial as unknown[])[r];
      if (!Array.isArray(row) || row.length !== n) {
        errors.push(`"initial"[${r}] must be an array of ${n} cell symbols`);
        ok = false;
        break;
      }
      const out: string[] = [];
      for (let c = 0; c < n; c++) {
        const v = (row as unknown[])[c];
        if (typeof v !== "string") {
          errors.push(`"initial"[${r}][${c}] must be one of "?", "C", ".", "X"`);
          ok = false;
          break;
        }
        const t = v.toUpperCase();
        if (t === "C") out.push(CROWN);
        else if (t === "." || t === "X") out.push(EMPTY);
        else if (t === "?") out.push(UNKNOWN);
        else {
          errors.push(`"initial"[${r}][${c}] must be one of "?", "C", ".", "X"`);
          ok = false;
          break;
        }
      }
      if (!ok) break;
      grid.push(out);
    }
    if (ok) initial = grid;
  }

  if (errors.length > 0 || regions === null || initial === null) {
    return { errors, puzzle: null };
  }

  // palette: optional array of n "#RRGGBB"/"#RGB" strings (rendering only)
  let palette: string[] | null = null;
  if (o.palette !== undefined) {
    if (!Array.isArray(o.palette) || (o.palette as unknown[]).length !== n) {
      errors.push(`"palette" must be an array of ${n} color strings when present`);
      return { errors, puzzle: null };
    }
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const v = (o.palette as unknown[])[i];
      const m = typeof v === "string" ? /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(v) : null;
      if (!m) {
        errors.push(`"palette"[${i}] must be a hex color like "#RRGGBB"`);
        return { errors, puzzle: null };
      }
      const h = m[1].length === 3 ? m[1].split("").map((d) => d + d).join("") : m[1];
      out.push("#" + h.toUpperCase());
    }
    palette = out;
  }

  return {
    errors,
    puzzle: {
      size: n,
      crownsPerRow: crownsPerRow as number,
      crownsPerColumn: crownsPerColumn as number,
      crownsPerRegion: crownsPerRegion as number,
      regions,
      regionCount: n,
      initial,
      palette,
    },
  };
}

/**
 * Check a fully-filled solution grid ("C"/".") against all puzzle rules.
 * Returns a list of violations (empty = valid).
 */
export function validateSolution(puzzle: NormalizedPuzzle, solution: string[][]): string[] {
  const errors: string[] = [];
  const n = puzzle.size;

  if (!Array.isArray(solution) || solution.length !== n) {
    return [`solution must have ${n} rows`];
  }
  for (let r = 0; r < n; r++) {
    if (!Array.isArray(solution[r]) || solution[r].length !== n) {
      return [`solution row ${r} must have ${n} cells`];
    }
    for (let c = 0; c < n; c++) {
      if (solution[r][c] !== CROWN && solution[r][c] !== EMPTY) {
        return [`solution[${r}][${c}] must be "C" or "."`];
      }
    }
  }

  const isCrown = (r: number, c: number) => solution[r][c] === CROWN;

  for (let r = 0; r < n; r++) {
    let k = 0;
    for (let c = 0; c < n; c++) if (isCrown(r, c)) k++;
    if (k !== puzzle.crownsPerRow) errors.push(`row ${r} has ${k} crowns, expected ${puzzle.crownsPerRow}`);
  }
  for (let c = 0; c < n; c++) {
    let k = 0;
    for (let r = 0; r < n; r++) if (isCrown(r, c)) k++;
    if (k !== puzzle.crownsPerColumn) errors.push(`column ${c} has ${k} crowns, expected ${puzzle.crownsPerColumn}`);
  }
  for (let g = 0; g < puzzle.regionCount; g++) {
    let k = 0;
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) if (puzzle.regions[r][c] === g && isCrown(r, c)) k++;
    if (k !== puzzle.crownsPerRegion) errors.push(`region ${g} has ${k} crowns, expected ${puzzle.crownsPerRegion}`);
  }

  const seen = new Set<string>();
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!isCrown(r, c)) continue;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nr >= n || nc < 0 || nc >= n || !isCrown(nr, nc)) continue;
          const a = `${r},${c}`;
          const b = `${nr},${nc}`;
          const key = a < b ? `${a}|${b}` : `${b}|${a}`;
          if (!seen.has(key)) {
            seen.add(key);
            const kind = dr === 0 || dc === 0 ? "orthogonally" : "diagonally";
            errors.push(`crowns at (${r},${c}) and (${nr},${nc}) touch ${kind}`);
          }
        }
      }
    }
  }
  return errors;
}
