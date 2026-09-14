import type { GameInstance } from "../types.js";
import { formatClock, todayUTC } from "../../leaderboard/api.js";
import { announceWin, createRunTimer } from "../../leaderboard/report.js";
import { boardEvents, type BoardDetail } from "../../leaderboard/view.js";
import { mulberry32 } from "../daily.js";
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
import {
  clampTentsSettings,
  loadEndlessSettings,
  saveEndlessSettings,
  setEndlessUnlocked,
  type TentsEndlessSettings,
} from "../mode.js";
import { createModeShell } from "../mode-shell.js";

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
  const modeDailyBtn = el<HTMLButtonElement>("tents-mode-daily");
  const modeEndlessBtn = el<HTMLButtonElement>("tents-mode-endless");
  const modeSep = el("tents-mode-sep");
  const settingsPanel = el("tents-settings");
  const settingsToggle = el<HTMLButtonElement>("tents-settings-toggle");
  const regenBtn = el<HTMLButtonElement>("tents-regen");
  const viewToggle = el<HTMLButtonElement>("tents-view-toggle");
  const lbView = el("tents-lb-view");
  const setSizeInput = el<HTMLInputElement>("tents-set-size");

  let board: TentsBoard | null = null;
  let started = false;
  /** UTC day key of the currently dealt daily board; re-deals at midnight rollover. */
  let dailyDay: string | null = null;
  const runTimer = createRunTimer();
  let moveCount = 0;
  let winReported = false;
  /** Mark history for the unified Undo button (unknown/grass/tent steps). */
  let undoStack: Array<{ r: number; c: number; prev: CellMark }> = [];

  const endlessTimer = createRunTimer();
  /** Stashed per-mode play state; working vars above always mirror the active mode. */
  interface Slot {
    board: TentsBoard;
    moveCount: number;
    undoStack: Array<{ r: number; c: number; prev: CellMark }>;
    winReported: boolean;
    day: string | null;
    timerLive: boolean;
  }
  let daily: Slot | null = null;
  let endless: Slot | null = null;

  function snapshot(): Slot | null {
    if (!started || !board) return null;
    return { board, moveCount, undoStack, winReported, day: dailyDay, timerLive: true };
  }

  const modeShell = createModeShell<Slot>({
    id: "tents",
    elements: {
      modeDaily: modeDailyBtn,
      modeEndless: modeEndlessBtn,
      modeSeparator: modeSep,
      settings: settingsPanel,
      settingsToggle,
      regenerate: regenBtn,
      viewToggle,
      leaderboardView: lbView,
      timerValue: "tents-timer-value",
    },
    dailyTimer: runTimer,
    endlessTimer,
    getSlot: (selectedMode) => selectedMode === "daily" ? daily : endless,
    setSlot: (selectedMode, slot) => {
      if (selectedMode === "daily") daily = slot;
      else endless = slot;
    },
    snapshot,
    restoreSlot: activateSlot,
    dealDaily,
    dealEndless,
    onEmptyDaily: () => {
      started = false;
      board = null;
      undoStack = [];
      message.textContent = "";
      level.textContent = "";
      undoButton.disabled = true;
      modeShell.ensureDaily();
    },
    hasDaily: (day) => daily?.day === day,
    canResume: () => started && board !== null && !board.over,
  });

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
    modeShell.activeTimer().stop();
    timerValue.textContent = formatClock(modeShell.activeTimer().elapsed());
  }

  const pauseClock = modeShell.pauseClock;
  const resumeClock = modeShell.resumeClock;

  function onBoardToggle(detail: BoardDetail): void {
    if (detail.game !== "tents") return;
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
        // Endless wins stay local: only daily wins reach the leaderboard.
        if (modeShell.mode === "daily") {
          // Solving the daily reveals the endless button (rest of the day).
          setEndlessUnlocked(todayUTC());
          announceWin({ game: "tents", durationMs: runTimer.elapsed(), moves: moveCount });
          modeShell.paintMode();
        }
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
    let levelData;
    try {
      levelData = generateLevel(TENTS_DEFAULT_SIZE, mulberry32(seed));
    } catch {
      if (modeShell.mode === "daily") message.textContent = "Could not deal today's puzzle.";
      return;
    }
    if (modeShell.mode !== "daily") {
      // Parked while endless is showing; timer starts on return to daily.
      daily = {
        board: createBoard(levelData),
        moveCount: 0,
        undoStack: [],
        winReported: false,
        day,
        timerLive: false,
      };
      return;
    }
    board = createBoard(levelData);
    dailyDay = day;
    started = true;
    moveCount = 0;
    winReported = false;
    undoStack = [];
    daily = { board, moveCount, undoStack, winReported, day, timerLive: true };
    runTimer.start();
    if (typeof document !== "undefined" && document.hidden) runTimer.pause();
    modeShell.bindTimerPill();
    buildGrid();
    paint();
    setStatus();
  }

  /** Read settings inputs, clamp, persist, and echo the clamped values back. */
  function readSettings(): TentsEndlessSettings {
    const clamped = clampTentsSettings({ size: setSizeInput.value });
    saveEndlessSettings("tents", clamped);
    setSizeInput.value = String(clamped.size);
    return clamped;
  }

  function fillSettingsInputs(s: TentsEndlessSettings): void {
    setSizeInput.value = String(s.size);
  }

  /** Deal a fresh endless board from the current settings; restarts the endless clock. */
  function dealEndless(): void {
    const s = readSettings();
    let levelData;
    try {
      levelData = generateLevel(s.size, Math.random);
    } catch {
      message.textContent = "Could not generate a board — try a smaller size.";
      return;
    }
    board = createBoard(levelData);
    dailyDay = null;
    started = true;
    moveCount = 0;
    winReported = false;
    undoStack = [];
    endless = { board, moveCount, undoStack, winReported, day: null, timerLive: true };
    endlessTimer.start();
    if (typeof document !== "undefined" && document.hidden) endlessTimer.pause();
    modeShell.bindTimerPill();
    buildGrid();
    paint();
    setStatus();
  }

  /** Show the stored slot's board; start or resume its timer as appropriate. */
  function activateSlot(slot: Slot): void {
    board = slot.board;
    moveCount = slot.moveCount;
    undoStack = slot.undoStack;
    winReported = slot.winReported;
    dailyDay = slot.day;
    started = true;
    const timer = modeShell.activeTimer();
    modeShell.bindTimerPill();
    buildGrid();
    paint();
    if (!slot.timerLive) {
      slot.timerLive = true;
      timer.start();
      if (typeof document !== "undefined" && document.hidden) timer.pause();
    } else if (board && !board.over) {
      timer.resume();
    }
    setStatus();
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
  boardEvents.on(onBoardToggle);
  modeShell.attachListeners();
  setSizeInput.addEventListener("change", readSettings);
  fillSettingsInputs(loadEndlessSettings("tents"));

  return {
    id: "tents",
    mount(): void {
      root.classList.remove("hidden");
      document.getElementById("top")?.classList.add("has-result");
      if (modeShell.mode === "endless") {
        if (endless && board) {
          paint();
          setStatus();
          resumeClock();
        } else {
          dealEndless();
        }
      } else if (!daily) {
        // Deal async; grid builds once the daily seed resolves.
        modeShell.ensureDaily();
      } else if (daily.day !== todayUTC()) {
        modeShell.ensureDaily();
      } else {
        paint();
        setStatus();
        resumeClock();
      }
      modeShell.paintMode();
    },
    unmount(): void {
      pauseClock();
      root.classList.add("hidden");
    },
    pauseClock,
    resumeClock,
  };
}
