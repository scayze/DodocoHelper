# Dodoco Helper — minigame collection

Daily logic minigames (Crowns, Minesweeper, Seasons, Tents & Trees, Snapshot)
with generated dailies, endless mode, and a friendly daily leaderboard.
Live at `strey.dev/dodoco/`.

## Quickstart

```sh
npm install
npm run dev      # Vite frontend (http://localhost:5173/dodoco/)
npm run dev:api  # leaderboard API on :3001 (watches dist-server)
npm run build    # typecheck + production build
npm test         # index check + typecheck + unit + screenshot fixtures
```

`docker compose up --build` runs the full stack (game + API).

## Architecture

```
src/main.ts              # shell: tabs, name gate, view switching
src/games/registry.ts    # game list → tabs (source of truth for games)
src/games/<id>/          # controller.ts + logic/solver + generator + stored.ts
src/games/mode-shell.ts  # daily/endless toggle, timer, settings overlay
src/games/mode.ts        # per-game endless settings + persistence
src/games/daily.ts       # daily seeds (server + offline fallback)
src/leaderboard/         # name gate, score submit, board view, toasts
server/app.ts            # API routes (healthz, leaderboard, scores, daily-seed, tinder)
index.html               # GENERATED — edit scripts/index.template.html instead
```

- Each game implements `GameDef{id, label, create}` → `GameInstance{mount, unmount, pauseClock, resumeClock}` (`src/games/types.ts`). Games own their DOM subtree and never touch another game's elements.
- Per-game folder pattern: `controller.ts` (wiring) + `logic/solver` + `generator` + `stored.ts` (persisted board shape). Crowns additionally has `view.ts`, `hints.ts`, `extract.ts` (screenshot → board).
- Modes: every load boots into **daily** (seed from `GET /api/daily-seed`, deterministic fallback offline). **Endless** settings persist in `localStorage`; progress persists per game via `stored.ts`.
- Leaderboard: nickname + anonymous UUID (no login). First `POST /api/scores` per `(day, game, player)` counts (`201`); retries get `409`. Day key is UTC, assigned server-side.
- Tinder (`/dodoco/tinder`) is a standalone curator view outside the game registry.

## API + deploy

| Method | Route | Notes |
|---|---|---|
| `GET` | `/api/healthz` | health check |
| `GET` | `/api/leaderboard?game=&day=&limit=` | daily board, day defaults to today UTC |
| `GET` | `/api/daily-seed?day=` | per-game RNG seeds for the day |
| `POST` | `/api/scores` | `{game, displayName, clientId, durationMs, moves, hintsUsed}` |
| `GET/POST` | `/api/tinder/*` | `next`, `vote`, `stats`, `export` (curator queue) |

Deploy: Vite builds with `base: '/dodoco/'`. Traefik matches `PathPrefix(/dodoco)`, strips it, → Caddy `:80` serves static and proxies `/api/*` → `api:3001`. SQLite lives in the `leaderboard-data` volume (`DB_PATH=/data/leaderboard.db`).

Optional: `BIGDATACLOUD_API_KEY` raises quotas for server-side reverse-geocode enrichment (city/locality/subdivision/country/continent on accepted Tinder rows, shown in Snapshot results). Without a key the keyless fair-use endpoint is used. Backfill: `npm run build:server && node scripts/backfill-geo.mjs`.

## Add a game

1. Create `src/games/<id>/` with `controller.ts` (return a `GameInstance`), plus solver/generator/`stored.ts`.
2. Register in `src/games/registry.ts` and `LEADERBOARD_GAMES` (`src/leaderboard/types.ts`).
3. Add its panel to `scripts/generate-index.mjs` (or custom markup in `scripts/index.template.html`), then `npm run generate:index`.
4. Add a test in `tests/` mirroring existing `<game>.test.ts`.

## Tests

- `npm test` — index freshness check, typecheck, `node:test` suite, crowns screenshot fixtures (gating; `PhoneFixtures` are best-effort).
- `npm run test:e2e` — built-harness browser run (`scripts/build-harness.mjs` + `harness/run.mjs`).
