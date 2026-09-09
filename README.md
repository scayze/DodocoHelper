# Dodoco Solver — Crown Puzzle Companion

Upload a crown puzzle screenshot and get the solved board with every crown placed.
Each row, column, and region holds exactly 2 crowns, and crowns never touch —
not even diagonally.

## Quickstart

```sh
npm install
npm run dev      # local dev server (proxies /api/* to localhost:3001)
npm run dev:api  # leaderboard API with file SQLite (DB_PATH, default ./data/leaderboard.db)
npm run build    # typecheck + production build
npm run preview  # serve the production build
npm test         # full test suite (unit + screenshot fixtures)
```

## Leaderboard (daily, one-shot, same deploy)

Each game reports wins to a daily per-game board. The day key is
UTC (`YYYY-MM-DD`) assigned server-side; players are identified by a
nickname + anonymous UUID stored in `localStorage` (no login, no rename —
the name is permanent until storage is cleared).

- Home shows a name gate until a name is saved; then the daily board shows.
  Chevron buttons beside the title step back a day or forward to today.
- Nameless wins queue client-side (earliest per game, day-stamped); confirming
  a name flushes the queue. Named wins submit immediately after each minigame
  with a small toast; offline failures re-queue and retry later.
- **One-shot:** the first `POST` per `(day, game, player)` counts; retries get
  `409`. Entries queued on a previous day are dropped and never reach the
  current board.

```sh
docker compose up --build   # :8080 serves the game; Caddy proxies /api/* to the api service
```

- `GET  /api/healthz`
- `GET  /api/leaderboard?game=crowns&day=2026-09-09&limit=20` (day defaults to today UTC)
- `POST /api/scores` `{game, displayName (2–20 chars), clientId (UUID), durationMs, moves?, hintsUsed?}` → `201` first submit, `409` retry
- SQLite lives in the `leaderboard-data` volume (`DB_PATH=/data/leaderboard.db`); back it up by copying that file.
- Abuse controls are best-effort v1: strict validation + per-IP/per-player rate limits. Times are client-reported, so treat the board as friendly rather than authoritative.

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
src/games/crowns/fixtures/  # ScreenshotFixtures (gating) + PhoneFixtures (best-effort)
src/games/minesweeper/      # logic + controller
src/games/seasons/          # logic + solver + generator + icons + controller
src/games/tents/            # logic + solver + generator + controller
src/games/registry.ts       # minigame list consumed by the shell
tests/                      # node:test suite (mirrors src/games/*)
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
- Sample boards live in `src/games/crowns/fixtures/`.
