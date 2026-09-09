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
npm test         # full test suite (unit + screenshot fixtures)
```

## How it works

1. **Start** from a screenshot of the board (PNG/JPEG/WebP), paste/drag it,
   or generate a fresh level with one click.
2. The app detects the board's grid with a lightweight pure-TypeScript
   pipeline (`src/games/crowns/extract.ts`): it classifies region colors, projects
   them onto both axes to find cell centers, and spots crowns / X marks.
3. The backtracking solver (`src/games/crowns/solver.ts`) places crowns with
   constraint propagation — sealed units, forced placements, MRV ordering.
4. **Hint** explains a guaranteed deduction and highlights its relevant row, column,
   region, or neighboring cells without revealing the answer; **Solve** reveals the full board.
5. Click any board cell to cycle it through unmarked, cross, queen, and unmarked again.
   Each edit re-solves the current board and clears any active hint.

## Layout

```
index.html                  # app entry (Vite): static DOM for all views
public/                     # favicon + dodoco artwork (served as-is)
src/main.ts                 # shell tab-router (tabs driven by games/registry.ts)
src/index.css               # Tailwind v4 theme
src/games/                  # one folder per minigame: logic + solver + generator + controller
src/games/crowns/           # solver/validator/hints/generator + extract (screenshot) + view + controller
src/games/minesweeper/      # logic + controller
src/games/seasons/          # logic + solver + generator + icons + controller
src/games/tents/            # logic + solver + generator + controller
src/games/registry.ts       # minigame list consumed by the shell
tests/                      # node:test suite (mirrors src/games/*)
test_fixtures/              # ScreenshotFixtures (gating) + PhoneFixtures (best-effort) + CrownsFixtures
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
- Sample boards live in `test_fixtures/`.
