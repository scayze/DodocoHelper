# Dodoco Solver — Crown Puzzle Companion

Upload a crown puzzle screenshot and get the solved board with every crown placed.
Each row, column, and region holds exactly 2 crowns, and crowns never touch —
not even diagonally.

## Quickstart

```sh
npm install
npm run dev      # local dev server
npm run build    # typecheck + production build
npm run preview  # serve the production build
npm test         # solver core test suite (26 tests)
```

## How it works

1. **Upload** a cropped screenshot of the board (PNG/JPEG/WebP).
2. The app loads bundled OpenCV.js, rectifies the board, detects its grid,
   clusters region colors, and spots X marks (`src/lib/extract.ts` and
   `src/lib/opencv.ts`). OpenCV is initialized on the first upload and is
   bundled locally rather than loaded from a CDN.
3. The backtracking solver (`src/core/solver.ts`) places crowns with
   constraint propagation — sealed units, forced placements, MRV ordering.
4. **Hint** reveals crowns one at a time; **Solve** reveals the full board.

## Layout

```
index.html                  # app entry (Vite)
public/                     # favicon + sample boards under examples/
src/main.ts                 # upload / solve / hint UI wiring
src/index.css               # Tailwind v4 theme
src/lib/extract.ts          # screenshot -> puzzle board
src/lib/renderBoard.ts      # DOM/SVG board rendering
src/core/                   # framework-free puzzle core (solver, validator, types)
tests/                      # node:test suite for the core
```

## Puzzle JSON schema

```json
{
  "size": 9,
  "crownsPerRow": 2,
  "crownsPerColumn": 2,
  "crownsPerRegion": 2,
  "regions": [[0, 0, 1, "..."]],
  "initial": [["?", "C", "."]],
  "palette": ["#74C6C4", "..."]
}
```

- `regions`: N×N ids `0..N-1`, exactly N distinct regions (any shape).
- `initial`: `"?"` unknown, `"C"` crown, `"."`/`"X"` forced empty.
- `palette`: optional per-region render colors.
- Sample boards live in `public/examples/`.
