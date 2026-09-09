import type { GameInstance } from "../types.js";
import { formatClock, todayUTC } from "../../leaderboard/api.js";
import { announceWin, bindTimerPill, createRunTimer } from "../../leaderboard/report.js";
import { fetchDailySeeds, mulberry32 } from "../daily.js";
import { generateRandomLevel } from "./generator.js";
import { SEASON_ICONS } from "./icons.js";
import {
  createBoard,
  findRegion,
  remainingCount,
  removeRegion,
  type SeasonsBoard,
} from "./logic.js";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

/** Shared FLIP timing for falls and column slides. */
const FLIP_MS = 240;

export function createSeasonsGame(): GameInstance {
  const root = el("seasons");
  const grid = el("seasons-grid");
  const message = el<HTMLParagraphElement>("seasons-message");
  const level = el("seasons-level");
  const timerValue = el("seasons-timer-value");

  let board: SeasonsBoard = createBoard();
  let started = false;
  /** UTC day key of the currently dealt board; re-deals at midnight rollover. */
  let dailyDay: string | null = null;
  const runTimer = createRunTimer();
  let moveCount = 0;
  let winReported = false;
  /**
   * Tile id -> chip element. Slots (grid buttons) stay put and keep focus;
   * chips move between slots so falls and slides can animate via FLIP.
   */
  const chips = new Map<number, HTMLElement>();
  /** Sorted cell-key list of the currently highlighted region; sticky over gaps. */
  let previewKey: string | null = null;
  /** True while slide/shrink animations are in flight; board clicks are ignored. */
  let animating = false;
  /** Bumps on every grid rebuild/unmount so stale flights can't repaint. */
  let moveEpoch = 0;
  /** Animations of the current flight; cancelled + cleared on teardown. */
  let flightAnims: Animation[] = [];

  /** Sync slots + chips to the board without animating. */
  function paint(): void {
    const n = board.size;
    const live = new Set<number>();
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const cell = grid.children[r * n + c] as HTMLElement | undefined;
        if (!cell) continue;
        const tile = board.cells[r][c];
        cell.classList.toggle("is-empty", tile === null);
        cell.setAttribute(
          "aria-label",
          `Row ${r + 1}, column ${c + 1}, ${tile?.t ?? "empty"}`,
        );
        const want = tile ? String(tile.id) : "";
        if (cell.dataset.k !== want) {
          cell.dataset.k = want;
          cell.replaceChildren();
          if (tile) {
            let chip = chips.get(tile.id);
            if (!chip) {
              chip = document.createElement("div");
              chip.className = `tile-chip season-${tile.t}`;
              chip.innerHTML = SEASON_ICONS[tile.t];
              chips.set(tile.id, chip);
            }
            live.add(tile.id);
            cell.appendChild(chip);
          }
        } else if (tile) {
          live.add(tile.id);
        }
      }
    }
    // Drop chips of cleared tiles so the pool never leaks.
    for (const id of chips.keys()) {
      if (!live.has(id)) chips.delete(id);
    }
    grid.setAttribute(
      "aria-label",
      `Seasons board, ${board.size} by ${board.size}, ${remainingCount(board)} pieces left`,
    );
  }

  function freezeClock(): void {
    runTimer.stop();
    timerValue.textContent = formatClock(runTimer.elapsed());
  }

  function setStatus(): void {
    const left = remainingCount(board);
    level.textContent = `${left} left`;
    if (board.over && board.won) {
      message.textContent = "Solved.";
      freezeClock();
    } else if (board.over) {
      message.textContent = "No moves left.";
      freezeClock();
    } else {
      message.textContent = "";
    }
  }

  function buildGrid(): void {
    grid.style.gridTemplateColumns = `repeat(${board.size}, minmax(0, 1fr))`;
    moveEpoch++;
    grid.replaceChildren();
    previewKey = null;
    teardownMove();
    chips.clear();
    const frag = document.createDocumentFragment();
    for (let r = 0; r < board.size; r++) {
      for (let c = 0; c < board.size; c++) {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "board-cell season-cell is-empty";
        cell.dataset.row = String(r);
        cell.dataset.col = String(c);
        cell.setAttribute("role", "gridcell");
        frag.appendChild(cell);
      }
    }
    grid.appendChild(frag);
  }

  /** Deal the fixed daily board (seed from server, generated client-side). */
  function dealDaily(day: string, seed: number): void {
    let levelData;
    try {
      levelData = generateRandomLevel(board.size, { rand: mulberry32(seed) });
    } catch {
      message.textContent = "Could not deal today's puzzle.";
      return;
    }
    board = createBoard(board.size);
    board.cells = levelData.cells;
    dailyDay = day;
    started = true;
    moveCount = 0;
    winReported = false;
    runTimer.start();
    bindTimerPill(runTimer, "seasons-timer-value", formatClock);
    buildGrid();
    paint();
    setStatus();
  }

  function ensureDaily(): void {
    const day = todayUTC();
    if (started && dailyDay === day) return;
    void fetchDailySeeds(day).then(({ day: seedDay, seeds }) => {
      if (started && dailyDay === seedDay) return;
      dealDaily(seedDay, seeds.seasons);
    });
  }

  function snapshotChips(): Map<number, DOMRect> {
    const rects = new Map<number, DOMRect>();
    for (const [id, chip] of chips) {
      if (chip.isConnected) rects.set(id, chip.getBoundingClientRect());
    }
    return rects;
  }

  function teardownMove(): void {
    animating = false;
    for (const a of flightAnims) {
      try {
        a.cancel();
      } catch {
        // Already finished/cancelled: nothing to do.
      }
    }
    flightAnims = [];
    grid.classList.remove("is-animating");
    for (const node of grid.querySelectorAll(".tile-chip.is-moving")) {
      node.classList.remove("is-moving");
    }
  }

  /**
   * Slide survivors from their pre-move rects to their new slots. Cleared
   * tiles vanish instantly; overflow clipping is lifted for the flight
   * (see .is-animating) so sliding chips stay visible over gaps.
   */
  function playMove(first: Map<number, DOMRect>): Promise<void> {
    grid.classList.add("is-animating");
    const animations: Animation[] = [];
    for (const [id, chip] of chips) {
      const f = first.get(id);
      if (!f || !chip.isConnected) continue;
      const l = chip.getBoundingClientRect();
      const dx = f.left - l.left;
      const dy = f.top - l.top;
      if (dx === 0 && dy === 0) continue;
      chip.classList.add("is-moving");
      animations.push(
        chip.animate(
          [
            { transform: `translate(${dx}px, ${dy}px)` },
            { transform: "translate(0, 0)" },
          ],
          // Hold the end state: with fill:none the chip would snap back to
          // its start offset for a frame before teardown runs.
          { duration: FLIP_MS, easing: "ease-out", fill: "forwards" },
        ),
      );
    }
    if (animations.length === 0) {
      teardownMove();
      return Promise.resolve();
    }
    flightAnims = animations;
    return Promise.allSettled(animations.map((a) => a.finished)).then(() => {
      teardownMove();
    });
  }

  function activateCell(cell: HTMLElement): void {
    if (!started || board.over || animating) return;
    const r = Number(cell.dataset.row);
    const c = Number(cell.dataset.col);
    if (!Number.isInteger(r) || !Number.isInteger(c)) return;
    // Singletons (no matching neighbor) are silently ignored.
    const region = findRegion(board, r, c);
    if (region.length < 2) return;
    clearPreview();
    const first = snapshotChips();
    removeRegion(board, region);
    moveCount++;
    paint();
    setStatus();
    if (board.over && board.won && !winReported) {
      winReported = true;
      announceWin({ game: "seasons", durationMs: runTimer.elapsed(), moves: moveCount });
    }
    cell.focus({ preventScroll: true });
    animating = true;
    const epoch = moveEpoch;
    void playMove(first).then(() => {
      if (epoch !== moveEpoch) return;
      // The pointer stays over the same slot, which now holds a new tile after
      // gravity: refresh the preview so the next removable region shows at once.
      showPreview(r, c);
    });
  }

  function cellAt(r: number, c: number): HTMLElement | undefined {
    const n = board.size;
    if (!Number.isInteger(r) || !Number.isInteger(c)) return undefined;
    if (r < 0 || r >= n || c < 0 || c >= n) return undefined;
    return grid.children[r * n + c] as HTMLElement | undefined;
  }

  function clearPreview(): void {
    previewKey = null;
    for (const node of grid.querySelectorAll(".is-preview")) {
      node.classList.remove("is-preview");
    }
  }

  function regionKey(region: Array<[number, number]>): string {
    return region
      .map(([r, c]) => r * board.size + c)
      .sort((a, b) => a - b)
      .join(",");
  }

  /** Highlight the whole removable region at (r, c); clears on singletons. */
  function showPreview(r: number, c: number): void {
    if (!started || board.over) return;
    const region = findRegion(board, r, c);
    if (region.length < 2) {
      // Entered a real cell with nothing removable: drop stale highlight.
      clearPreview();
      return;
    }
    const key = regionKey(region);
    // Same region (e.g. moving between its tiles): keep DOM as-is, no flicker.
    if (key === previewKey) return;
    clearPreview();
    for (const [rr, cc] of region) {
      cellAt(rr, cc)?.classList.add("is-preview");
    }
    previewKey = key;
  }

  function previewFromEvent(e: Event): void {
    const cell = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-row][data-col]",
    );
    // Sticky over gaps/padding: keep the last region until another cell or
    // grid-leave resolves it. Only pointerleave/focusout clear stale state.
    if (!cell || !grid.contains(cell)) return;
    const r = Number(cell.dataset.row);
    const c = Number(cell.dataset.col);
    if (!Number.isInteger(r) || !Number.isInteger(c)) return;
    showPreview(r, c);
  }

  function onClick(e: MouseEvent): void {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-row][data-col]");
    if (cell && grid.contains(cell)) activateCell(cell);
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key !== "Enter" && e.key !== " ") return;
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-row][data-col]");
    if (!cell || !grid.contains(cell)) return;
    e.preventDefault();
    activateCell(cell);
  }

  grid.addEventListener("click", onClick);
  grid.addEventListener("keydown", onKey);
  // Hover / keyboard focus previews the entire region that a click would remove.
  grid.addEventListener("pointerover", previewFromEvent);
  grid.addEventListener("pointerleave", clearPreview);
  grid.addEventListener("focusin", previewFromEvent);
  grid.addEventListener("focusout", clearPreview);

  return {
    id: "seasons",
    mount(): void {
      root.classList.remove("hidden");
      document.getElementById("top")?.classList.add("has-result");
      if (!started) {
        buildGrid();
        paint();
        setStatus();
        ensureDaily();
      } else if (dailyDay !== todayUTC()) {
        ensureDaily();
      } else {
        clearPreview();
        paint();
        setStatus();
      }
    },
    unmount(): void {
      moveEpoch++;
      clearPreview();
      teardownMove();
      root.classList.add("hidden");
    },
  };
}
