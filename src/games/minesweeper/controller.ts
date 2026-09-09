import type { GameInstance } from "../types.js";
import { formatClock, todayUTC } from "../../leaderboard/api.js";
import { announceWin, bindTimerPill, createRunTimer } from "../../leaderboard/report.js";
import { fetchDailySeeds, mulberry32 } from "../daily.js";
import {
  chord,
  createBoard,
  minePositions,
  reveal,
  toggleFlag,
  type MineBoard,
} from "./logic.js";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const NUMBER_COLORS = [
  "",
  "#2f6fb2",
  "#3d8a4f",
  "#b0413e",
  "#6a4fb3",
  "#a37f1c",
  "#2f9d96",
  "#5b5b5b",
  "#223154",
];

export function createMinesweeperGame(): GameInstance {
  const root = el("mines");
  const grid = el("mines-grid");
  const message = el<HTMLParagraphElement>("mines-message");
  const level = el("mines-level");
  const timerValue = el("mines-timer-value");

  /** Hold duration (ms) that turns a touch press into a flag toggle. */
  const LONG_PRESS_MS = 450;

  let board: MineBoard = createBoard();
  /** Seeded RNG for this daily's deferred mine placement. */
  let boardRand: () => number = Math.random;
  let started = false;
  /** UTC day key of the currently dealt board; re-deals at midnight rollover. */
  let dailyDay: string | null = null;
  const runTimer = createRunTimer();
  let winReported = false;
  let pressTimer: number | null = null;
  let pressCell: HTMLElement | null = null;
  /** Pointer type of the last press; right-click (mouse) never suppresses clicks. */
  let lastPointerType = "mouse";
  /** Freshly flagged cell, so the press-timer and contextmenu paths don't double-toggle. */
  let recentFlagKey = "";
  let recentFlagAt = 0;

  function flaggedCount(): number {
    let n = 0;
    for (let r = 0; r < board.size; r++) {
      for (let c = 0; c < board.size; c++) {
        if (board.state[r][c] === "flagged") n++;
      }
    }
    return n;
  }

  function paint(): void {
    const n = board.size;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const cell = grid.children[r * n + c] as HTMLElement | undefined;
        const chip = cell?.firstElementChild as HTMLElement | null;
        if (!cell || !chip) continue;
        const st = board.state[r][c];
        const isMine = board.mines[r][c];
        const revealed = st === "revealed";
        const flagged = st === "flagged";
        const count = board.adjacent[r][c];

        cell.classList.toggle("is-revealed", revealed);
        cell.classList.toggle("is-flagged", flagged);
        cell.classList.toggle("is-mine", revealed && isMine);
        cell.setAttribute(
          "aria-label",
          `Row ${r + 1}, column ${c + 1}, ${
            revealed ? (isMine ? "mine" : `${count} nearby`) : flagged ? "flagged" : "hidden"
          }`,
        );
        if (revealed && !isMine && count > 0) {
          chip.textContent = String(count);
          chip.style.color = NUMBER_COLORS[count] ?? "#223154";
        } else if (revealed && isMine) {
          chip.textContent = "✸";
          chip.style.color = "";
        } else if (flagged) {
          chip.textContent = "⚑";
          chip.style.color = "";
        } else {
          chip.textContent = "";
          chip.style.color = "";
        }
      }
    }
    const total = board.size * board.size - board.mineCount;
    grid.setAttribute(
      "aria-label",
      `Minesweeper board, ${board.size} by ${board.size}, ${board.revealedCount} of ${total} safe cells revealed`,
    );
  }

  function freezeClock(): void {
    runTimer.stop();
    timerValue.textContent = formatClock(runTimer.elapsed());
  }

  function setStatus(): void {
    const left = Math.max(0, board.mineCount - flaggedCount());
    level.textContent = `${board.mineCount} mines · ${left} left`;
    if (board.over && board.won) {
      message.textContent = "Solved.";
      freezeClock();
      if (!winReported) {
        winReported = true;
        announceWin({ game: "minesweeper", durationMs: runTimer.elapsed(), moves: board.revealedCount });
      }
    } else if (board.over) {
      message.textContent = "Boom — that one had a mine.";
      freezeClock();
    } else {
      message.textContent = "";
    }
  }

  function buildGrid(): void {
    grid.style.gridTemplateColumns = `repeat(${board.size}, minmax(0, 1fr))`;
    grid.replaceChildren();
    const frag = document.createDocumentFragment();
    for (let r = 0; r < board.size; r++) {
      for (let c = 0; c < board.size; c++) {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "board-cell mine-cell";
        cell.dataset.row = String(r);
        cell.dataset.col = String(c);
        cell.setAttribute("role", "gridcell");
        const chip = document.createElement("div");
        chip.className = "mine-chip";
        chip.setAttribute("aria-hidden", "true");
        cell.appendChild(chip);
        frag.appendChild(cell);
      }
    }
    grid.appendChild(frag);
  }

  /** Deal the fixed daily board (seed from server, generated client-side). */
  function dealDaily(day: string, seed: number): void {
    board = createBoard();
    boardRand = mulberry32(seed);
    dailyDay = day;
    started = true;
    winReported = false;
    runTimer.start();
    bindTimerPill(runTimer, "mines-timer-value", formatClock);
    clearPress();
    buildGrid();
    paint();
    setStatus();
  }

  function ensureDaily(): void {
    const day = todayUTC();
    if (started && dailyDay === day) return;
    void fetchDailySeeds(day).then(({ day: seedDay, seeds }) => {
      if (started && dailyDay === seedDay) return;
      dealDaily(seedDay, seeds.minesweeper);
    });
  }

  function cellCoords(cell: HTMLElement): [number, number] | null {
    const r = Number(cell.dataset.row);
    const c = Number(cell.dataset.col);
    if (!Number.isInteger(r) || !Number.isInteger(c)) return null;
    return [r, c];
  }

  function flagCell(cell: HTMLElement): void {
    if (!started || board.over) return;
    const coords = cellCoords(cell);
    if (!coords) return;
    const [r, c] = coords;
    const before = board.state[r][c];
    toggleFlag(board, r, c);
    if (board.state[r][c] === before) return;
    recentFlagKey = `${r},${c}`;
    recentFlagAt = performance.now();
    paint();
    setStatus();
    cell.focus({ preventScroll: true });
  }

  /** True when this cell was (un)flagged a moment ago by the other press path. */
  function recentlyFlagged(r: number, c: number): boolean {
    return recentFlagKey === `${r},${c}` && performance.now() - recentFlagAt < 700;
  }

  function activateCell(cell: HTMLElement): void {
    if (!started || board.over) return;
    const coords = cellCoords(cell);
    if (!coords) return;
    const [r, c] = coords;
    if (board.state[r][c] === "flagged") {
      // Forgiving tap: tapping a flag removes it (long-press re-flags).
      toggleFlag(board, r, c);
    } else {
      const hitMine = reveal(board, r, c, boardRand);
      if (hitMine) revealAllMines();
    }
    paint();
    setStatus();
    cell.focus({ preventScroll: true });
  }

  /** Expose every mine after a loss so the board tells the story. */
  function revealAllMines(): void {
    for (const [mr, mc] of minePositions(board)) {
      board.state[mr][mc] = "revealed";
    }
  }

  /** Double-click / double-tap on a satisfied number opens its neighbors. */
  function chordCell(cell: HTMLElement): void {
    if (!started || board.over) return;
    const coords = cellCoords(cell);
    if (!coords) return;
    const hitMine = chord(board, coords[0], coords[1], boardRand);
    if (hitMine) revealAllMines();
    paint();
    setStatus();
    cell.focus({ preventScroll: true });
  }

  function clearPress(): void {
    if (pressTimer !== null) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    pressCell = null;
  }

  function onPointerDown(e: PointerEvent): void {
    lastPointerType = e.pointerType;
    // Mouse uses click / right-click; touch uses tap / long-press.
    if (e.pointerType === "mouse") return;
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-row][data-col]");
    if (!cell || !grid.contains(cell)) return;
    clearPress();
    pressCell = cell;
    pressTimer = window.setTimeout(() => {
      pressTimer = null;
      const target = pressCell;
      pressCell = null;
      if (!target) return;
      const coords = cellCoords(target);
      if (!coords) return;
      // The companion contextmenu may fire right after this; it sees the
      // fresh flag below and skips its own toggle.
      if (!recentlyFlagged(coords[0], coords[1])) flagCell(target);
    }, LONG_PRESS_MS);
  }

  function onClick(e: MouseEvent): void {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-row][data-col]");
    if (!cell || !grid.contains(cell)) return;
    const coords = cellCoords(cell);
    // Swallow the release tap that follows a touch long-press / menu flag so
    // the freshly placed flag sticks. Mouse clicks are never suppressed.
    if (coords && lastPointerType !== "mouse" && recentlyFlagged(coords[0], coords[1])) return;
    activateCell(cell);
  }

  function onContextMenu(e: MouseEvent): void {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-row][data-col]");
    if (!cell || !grid.contains(cell)) return;
    e.preventDefault();
    if (!started || board.over) return;
    const coords = cellCoords(cell);
    if (!coords) return;
    // A touch long-press can trigger both the press-timer and this menu;
    // whoever runs second sees the fresh flag and skips its own toggle.
    if (!recentlyFlagged(coords[0], coords[1])) flagCell(cell);
    cell.focus({ preventScroll: true });
  }

  function onKey(e: KeyboardEvent): void {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-row][data-col]");
    if (!cell || !grid.contains(cell)) return;
    // Keyboard flagging (replaces the removed Flag toggle button).
    if (e.key === "f" || e.key === "F") {
      flagCell(cell);
      return;
    }
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    // Enter/Space on a revealed number chords; elsewhere it reveals.
    const coords = cellCoords(cell);
    if (coords && board.state[coords[0]][coords[1]] === "revealed") chordCell(cell);
    else activateCell(cell);
  }

  function onDoubleClick(e: MouseEvent): void {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-row][data-col]");
    if (cell && grid.contains(cell)) chordCell(cell);
  }

  grid.addEventListener("click", onClick);
  grid.addEventListener("dblclick", onDoubleClick);
  grid.addEventListener("contextmenu", onContextMenu);
  grid.addEventListener("keydown", onKey);
  grid.addEventListener("pointerdown", onPointerDown);
  grid.addEventListener("pointerup", clearPress);
  grid.addEventListener("pointercancel", clearPress);
  grid.addEventListener("pointerleave", clearPress);

  return {
    id: "minesweeper",
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
        paint();
        setStatus();
      }
    },
    unmount(): void {
      root.classList.add("hidden");
    },
  };
}
