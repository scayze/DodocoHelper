import type { GameInstance } from "../types.js";
import { formatClock, todayUTC } from "../../leaderboard/api.js";
import { announceWin, createRunTimer } from "../../leaderboard/report.js";
import { boardEvents, type BoardDetail } from "../../leaderboard/view.js";
import { settingsEvents, type SettingsDetail } from "../mode-shell.js";
import { dailyCompleteMessage, mulberry32 } from "../daily.js";
import { checkWin, createBoard, rowIsValid, swapCells } from "./logic.js";
import { ROW_COUNT, type Card, type ShapesBoard } from "./types.js";
import { generatePuzzle } from "./generator.js";
import { setEndlessUnlocked } from "../mode.js";
import { createModeShell } from "../mode-shell.js";
import { loadBoardState, saveBoardState } from "../persist.js";
import { isShapesStored } from "./stored.js";
import { buildShapesGrid, paintShapesBoard } from "./view.js";
import { el } from "../dom.js";

export function createShapesGame(): GameInstance {
  const root = el("shapes");
  const grid = el("shapes-grid");
  const message = el<HTMLParagraphElement>("shapes-message");
  const timerValue = el("shapes-timer-value");
  const modeDailyBtn = el<HTMLButtonElement>("shapes-mode-daily");
  const modeEndlessBtn = el<HTMLButtonElement>("shapes-mode-endless");
  const modeSep = el("shapes-mode-sep");
  const gridWrap = el("shapes-grid-wrap");
  const settingsPanel = el("shapes-settings");
  const settingsToggle = el<HTMLButtonElement>("shapes-settings-toggle");
  const regenBtn = el<HTMLButtonElement>("shapes-regen");
  const viewToggle = el<HTMLButtonElement>("shapes-view-toggle");
  const lbView = el("shapes-lb-view");

  let board: ShapesBoard | null = null;
  let selected: number | null = null;
  let started = false;
  /** UTC day key of the currently dealt daily board; re-deals at midnight rollover. */
  let dailyDay: string | null = null;
  const runTimer = createRunTimer();
  let moveCount = 0;
  let winReported = false;

  const endlessTimer = createRunTimer();
  /** Stashed per-mode play state; working vars above always mirror the active mode. */
  interface Slot {
    board: ShapesBoard;
    selected: number | null;
    moveCount: number;
    winReported: boolean;
    day: string | null;
    timerLive: boolean;
  }
  let daily: Slot | null = null;
  let endless: Slot | null = null;

  // Restore boards persisted across reloads. The daily is bound to its UTC
  // day: a new day deals a new seed, so stored days other than today are
  // cleared and dropped (mount then deals a fresh board).
  {
    const today = todayUTC();
    const storedDaily = loadBoardState("shapes", "daily", isShapesStored, today);
    if (storedDaily) {
      daily = {
        board: createBoard(storedDaily.state.board.cards, storedDaily.state.board.pos),
        selected: storedDaily.state.selected,
        moveCount: storedDaily.state.moveCount,
        winReported: storedDaily.state.winReported,
        day: today,
        timerLive: storedDaily.timerLive,
      };
      daily.board.over = storedDaily.state.board.over;
      daily.board.won = storedDaily.state.board.won;
      runTimer.restoreElapsed(storedDaily.elapsedMs);
    }
    const storedEndless = loadBoardState("shapes", "endless", isShapesStored, today);
    if (storedEndless) {
      endless = {
        board: createBoard(storedEndless.state.board.cards, storedEndless.state.board.pos),
        selected: storedEndless.state.selected,
        moveCount: storedEndless.state.moveCount,
        winReported: storedEndless.state.winReported,
        day: null,
        timerLive: storedEndless.timerLive,
      };
      endless.board.over = storedEndless.state.board.over;
      endless.board.won = storedEndless.state.board.won;
      endlessTimer.restoreElapsed(storedEndless.elapsedMs);
    }
  }

  function snapshot(): Slot | null {
    if (!started || !board) return null;
    return { board, selected, moveCount, winReported, day: dailyDay, timerLive: true };
  }

  const modeShell = createModeShell<Slot>({
    id: "shapes",
    elements: {
      modeDaily: modeDailyBtn,
      modeEndless: modeEndlessBtn,
      modeSeparator: modeSep,
      settings: settingsPanel,
      settingsToggle,
      regenerate: regenBtn,
      viewToggle,
      leaderboardView: lbView,
      gridWrap,
      timerValue: "shapes-timer-value",
    },
    dailyTimer: runTimer,
    endlessTimer,
    getSlot: (selectedMode) => (selectedMode === "daily" ? daily : endless),
    setSlot: (selectedMode, slot) => {
      if (selectedMode === "daily") daily = slot;
      else endless = slot;
      persistActive();
    },
    snapshot,
    restoreSlot: activateSlot,
    dealDaily,
    dealEndless,
    onEmptyDaily: () => {
      started = false;
      board = null;
      selected = null;
      message.textContent = "";
      modeShell.ensureDaily();
    },
    hasDaily: (day) => daily?.day === day,
    canResume: () => started && board !== null && !board.over,
  });

  function paint(): void {
    if (!board) return;
    paintShapesBoard(grid, board, selected);
  }

  function rowsDone(): number {
    if (!board) return 0;
    let n = 0;
    for (let r = 0; r < ROW_COUNT; r++) if (rowIsValid(board, r)) n++;
    return n;
  }

  function freezeClock(): void {
    modeShell.activeTimer().stop();
    timerValue.textContent = formatClock(modeShell.activeTimer().elapsed());
  }

  const pauseClock = modeShell.pauseClock;
  const resumeClock = modeShell.resumeClock;

  function onBoardToggle(detail: BoardDetail): void {
    if (detail.game !== "shapes") return;
    if (detail.showingBoard) pauseClock();
    else if (settingsPanel.classList.contains("hidden")) resumeClock();
  }

  function onSettingsToggle(detail: SettingsDetail): void {
    if (detail.game !== "shapes") return;
    if (detail.settingsOpen) pauseClock();
    else if (lbView.classList.contains("hidden")) resumeClock();
  }

  function setStatus(): void {
    if (!board) return;
    if (board.over && board.won) {
      message.textContent =
        modeShell.mode === "daily" ? dailyCompleteMessage() : "Solved.";
      freezeClock();
      if (!winReported) {
        winReported = true;
        // Endless wins stay local: only daily wins reach the leaderboard.
        if (modeShell.mode === "daily") {
          // Finishing the daily reveals the endless button (rest of the day).
          setEndlessUnlocked("shapes", todayUTC());
          announceWin({ game: "shapes", durationMs: runTimer.elapsed(), moves: moveCount });
          modeShell.paintMode();
        }
      }
    } else {
      const done = rowsDone();
      message.textContent =
        done > 0
          ? `${done} of ${ROW_COUNT} rows complete.`
          : "Swap two cards to start — every row must be a set.";
    }
  }

  function dealPuzzle(cards: Card[], pos: number[], day: string | null): void {
    board = createBoard(cards, pos);
    dailyDay = day;
    started = true;
    selected = null;
    moveCount = 0;
    winReported = false;
  }

  /** Deal the fixed daily board (seed from server, generated client-side). */
  function dealDaily(day: string, seed: number): void {
    let puzzle;
    try {
      puzzle = generatePuzzle(mulberry32(seed));
    } catch {
      if (modeShell.mode === "daily") message.textContent = "Could not deal today's puzzle.";
      return;
    }
    if (modeShell.mode !== "daily") {
      // Parked while endless is showing; timer starts on return to daily.
      daily = {
        board: createBoard(puzzle.cards, puzzle.pos),
        selected: null,
        moveCount: 0,
        winReported: false,
        day,
        timerLive: false,
      };
      return;
    }
    dealPuzzle(puzzle.cards, puzzle.pos, day);
    daily = { board: board!, selected, moveCount, winReported, day, timerLive: true };
    runTimer.start();
    if (typeof document !== "undefined" && document.hidden) runTimer.pause();
    modeShell.bindTimerPill();
    buildShapesGrid(grid, tapCell);
    paint();
    setStatus();
    persistActive();
  }

  /** Deal a fresh endless board; restarts the endless clock. */
  function dealEndless(): void {
    let puzzle;
    try {
      puzzle = generatePuzzle(Math.random);
    } catch {
      message.textContent = "Could not generate a board — try again.";
      return;
    }
    dealPuzzle(puzzle.cards, puzzle.pos, null);
    endless = { board: board!, selected, moveCount, winReported, day: null, timerLive: true };
    endlessTimer.start();
    if (typeof document !== "undefined" && document.hidden) endlessTimer.pause();
    modeShell.bindTimerPill();
    buildShapesGrid(grid, tapCell);
    paint();
    setStatus();
    persistActive();
  }

  /** Show the stored slot's board; start or resume its timer as appropriate. */
  function activateSlot(slot: Slot): void {
    board = slot.board;
    selected = slot.selected;
    moveCount = slot.moveCount;
    winReported = slot.winReported;
    dailyDay = slot.day;
    started = true;
    const timer = modeShell.activeTimer();
    modeShell.bindTimerPill();
    buildShapesGrid(grid, tapCell);
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

  /** Persist the active board so a reload can restore it (played state only). */
  function persistActive(): void {
    const slot = snapshot();
    if (!slot) return;
    saveBoardState("shapes", modeShell.mode, {
      day: slot.day,
      elapsedMs: modeShell.activeTimer().elapsed(),
      timerLive: true,
      state: {
        board: slot.board,
        moveCount: slot.moveCount,
        selected: slot.selected,
        winReported: slot.winReported,
      },
    });
  }

  function focusCell(cell: number): void {
    const node = grid.children[cell] as HTMLElement | undefined;
    node?.focus({ preventScroll: true });
  }

  /** Tap-tap swap: first tap selects, second tap swaps (or deselects). */
  function tapCell(cell: number): void {
    if (!started || !board || board.over) return;
    if (selected === null) {
      selected = cell;
      paint();
      persistActive();
      return;
    }
    if (selected === cell) {
      selected = null;
      paint();
      persistActive();
      return;
    }
    if (!swapCells(board, selected, cell)) return;
    moveCount++;
    selected = null;
    checkWin(board);
    paint();
    setStatus();
    focusCell(cell);
    persistActive();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key !== "Enter" && e.key !== " ") return;
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-cell]");
    if (!cell || !grid.contains(cell)) return;
    e.preventDefault();
    tapCell(Number(cell.dataset.cell));
  }

  boardEvents.on(onBoardToggle);
  settingsEvents.on(onSettingsToggle);
  modeShell.attachListeners();
  grid.addEventListener("keydown", onKey);

  return {
    id: "shapes",
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
      } else if (board !== daily.board) {
        // Freshly restored daily: sync the live globals to the stored slot.
        activateSlot(daily);
      } else {
        paint();
        setStatus();
        resumeClock();
      }
      modeShell.paintMode();
    },
    unmount(): void {
      selected = null;
      pauseClock();
      root.classList.add("hidden");
    },
    pauseClock,
    resumeClock,
  };
}
