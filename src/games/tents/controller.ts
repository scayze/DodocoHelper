import type { GameInstance } from "../types.js";
import { formatClock, todayUTC } from "../../leaderboard/api.js";
import { announceWin, bindTimerPill, createRunTimer } from "../../leaderboard/report.js";
import { BOARD_EVENT, type BoardDetail } from "../../leaderboard/view.js";
import { fetchDailySeeds, mulberry32 } from "../daily.js";
import {
  checkWin,
  createBoard,
  TENTS_DEFAULT_SIZE,
  tentsInCol,
  tentsInRow,
  totalTents,
  tentsPlaced,
  toggleMark,
  type CellMark,
  type TentsBoard,
} from "./logic.js";
import { generateLevel } from "./generator.js";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

export function createTentsGame(): GameInstance {
  const root = el("tents");
  const grid = el("tents-grid");
  const message = el<HTMLParagraphElement>("tents-message");
  const level = el("tents-level");
  const undoButton = el<HTMLButtonElement>("tents-undo-button");
  const timerValue = el("tents-timer-value");

  let board: TentsBoard | null = null;
  let started = false;
  /** UTC day key of the currently dealt board; re-deals at midnight rollover. */
  let dailyDay: string | null = null;
  const runTimer = createRunTimer();
  let moveCount = 0;
  let winReported = false;
  /** Mark history for the unified Undo button (unknown/grass/tent steps). */
  let undoStack: Array<{ r: number; c: number; prev: CellMark }> = [];

  function paint(): void {
    if (!board) return;
    const n = board.size;
    for (let r = -1; r < n; r++) {
      for (let c = -1; c < n; c++) {
        const node = grid.children[(r + 1) * (n + 1) + (c + 1)] as HTMLElement | undefined;
        const chip = node?.firstElementChild as HTMLElement | null;
        if (!node || !chip) continue;
        if (r === -1 && c === -1) continue;
        if (r === -1) {
          // Countdown of tents still to place; negative means overfilled.
          const left = board.colCounts[c] - tentsInCol(board, c);
          chip.textContent = String(left);
          node.classList.toggle("is-ok", left === 0);
          node.classList.toggle("is-over", left < 0);
          continue;
        }
        if (c === -1) {
          const left = board.rowCounts[r] - tentsInRow(board, r);
          chip.textContent = String(left);
          node.classList.toggle("is-ok", left === 0);
          node.classList.toggle("is-over", left < 0);
          continue;
        }
        const isTree = board.trees[r][c];
        const mark = board.marks[r][c];
        node.classList.toggle("is-tree", isTree);
        node.classList.toggle("is-tent", !isTree && mark === "tent");
        node.classList.toggle("is-grass", !isTree && mark === "grass");
        chip.textContent = isTree ? "🌲" : mark === "tent" ? "⛺" : "";
        node.setAttribute(
          "aria-label",
          `Row ${r + 1}, column ${c + 1}, ${isTree ? "tree" : mark}`,
        );
      }
    }
    grid.setAttribute(
      "aria-label",
      `Tents and Trees board, ${n} by ${n}, ${tentsPlaced(board)} of ${totalTents(board)} tents placed`,
    );
  }

  function freezeClock(): void {
    runTimer.stop();
    timerValue.textContent = formatClock(runTimer.elapsed());
  }

  function pauseClock(): void {
    runTimer.pause();
  }

  function resumeClock(): void {
    if (started && board && !board.over) runTimer.resume();
  }

  function onBoardToggle(e: Event): void {
    const detail = (e as CustomEvent<BoardDetail>).detail;
    if (!detail || detail.game !== "tents") return;
    if (detail.showingBoard) pauseClock();
    else resumeClock();
  }

  function refreshUndo(): void {
    undoButton.disabled = undoStack.length === 0 || !board || board.over;
  }

  function setStatus(): void {
    if (!board) return;
    level.textContent = `${tentsPlaced(board)}/${totalTents(board)} tents`;
    if (board.over && board.won) {
      message.textContent = "Solved.";
      freezeClock();
      if (!winReported) {
        winReported = true;
        announceWin({ game: "tents", durationMs: runTimer.elapsed(), moves: moveCount });
      }
    } else {
      message.textContent = "";
    }
    refreshUndo();
  }

  function buildGrid(): void {
    if (!board) return;
    const n = board.size;
    grid.style.gridTemplateColumns = `repeat(${n + 1}, minmax(0, 1fr))`;
    grid.replaceChildren();
    const frag = document.createDocumentFragment();
    for (let r = -1; r < n; r++) {
      for (let c = -1; c < n; c++) {
        if (r === -1 || c === -1) {
          const head = document.createElement("div");
          head.className = "count-head" + (r === -1 && c === -1 ? " is-corner" : "");
          head.setAttribute("aria-hidden", "true");
          const chip = document.createElement("div");
          chip.className = "count-chip";
          head.appendChild(chip);
          frag.appendChild(head);
        } else {
          const cell = document.createElement("button");
          cell.type = "button";
          cell.className = "board-cell tent-cell";
          cell.dataset.row = String(r);
          cell.dataset.col = String(c);
          cell.setAttribute("role", "gridcell");
          const chip = document.createElement("div");
          chip.className = "tent-chip";
          chip.setAttribute("aria-hidden", "true");
          cell.appendChild(chip);
          frag.appendChild(cell);
        }
      }
    }
    grid.appendChild(frag);
  }

  /** Deal the fixed daily board (seed from server, generated client-side). */
  function dealDaily(day: string, seed: number): void {
    let level;
    try {
      level = generateLevel(TENTS_DEFAULT_SIZE, mulberry32(seed));
    } catch {
      message.textContent = "Could not deal today's puzzle.";
      return;
    }
    board = createBoard(level);
    dailyDay = day;
    started = true;
    moveCount = 0;
    winReported = false;
    undoStack = [];
    runTimer.start();
    if (typeof document !== "undefined" && document.hidden) runTimer.pause();
    bindTimerPill(runTimer, "tents-timer-value", formatClock);
    buildGrid();
    paint();
    setStatus();
  }

  function ensureDaily(): void {
    const day = todayUTC();
    if (started && dailyDay === day) return;
    void fetchDailySeeds(day).then(({ day: seedDay, seeds }) => {
      if (started && dailyDay === seedDay) return;
      dealDaily(seedDay, seeds.tents);
    });
  }

  function activateCell(cell: HTMLElement): void {
    if (!started || !board || board.over) return;
    const r = Number(cell.dataset.row);
    const c = Number(cell.dataset.col);
    if (!Number.isInteger(r) || !Number.isInteger(c)) return;
    if (r < 0 || r >= board.size || c < 0 || c >= board.size) return;
    if (board.trees[r][c]) return;
    undoStack.push({ r, c, prev: board.marks[r][c] });
    if (!toggleMark(board, r, c)) {
      undoStack.pop();
      return;
    }
    checkWin(board);
    moveCount++;
    paint();
    setStatus();
    cell.focus({ preventScroll: true });
  }

  function undo(): void {
    if (!board || board.over || undoStack.length === 0 || undoButton.disabled) return;
    const last = undoStack.pop()!;
    board.marks[last.r][last.c] = last.prev;
    checkWin(board);
    paint();
    setStatus();
    const node = grid.children[(last.r + 1) * (board.size + 1) + (last.c + 1)] as
      | HTMLElement
      | undefined;
    node?.focus({ preventScroll: true });
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
  undoButton.addEventListener("click", undo);
  window.addEventListener(BOARD_EVENT, onBoardToggle);

  return {
    id: "tents",
    mount(): void {
      root.classList.remove("hidden");
      document.getElementById("top")?.classList.add("has-result");
      if (!started) {
        // Deal async; grid builds once the daily seed resolves.
        ensureDaily();
      } else if (dailyDay !== todayUTC()) {
        ensureDaily();
      } else {
        paint();
        setStatus();
        resumeClock();
      }
    },
    unmount(): void {
      pauseClock();
      root.classList.add("hidden");
    },
    pauseClock,
    resumeClock,
  };
}
