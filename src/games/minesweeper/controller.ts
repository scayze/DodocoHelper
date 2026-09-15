import type { GameInstance } from "../types.js";
import { formatClock, todayUTC } from "../../leaderboard/api.js";
import { announceResult, createRunTimer } from "../../leaderboard/report.js";
import { boardEvents, type BoardDetail } from "../../leaderboard/view.js";
import { settingsEvents, type SettingsDetail } from "../mode-shell.js";
import { isDailyComplete, loadDailyResult, saveDailyResult } from "../daily-result.js";
import { dailyCompleteMessage, mulberry32 } from "../daily.js";
import {
  clampMinesSettings,
  loadEndlessSettings,
  saveEndlessSettings,
  setEndlessUnlocked,
  type MinesEndlessSettings,
} from "../mode.js";
import { createModeShell, type ModeShell } from "../mode-shell.js";
import { loadBoardState, saveBoardState } from "../persist.js";
import { isMineStored, type MineStored } from "./stored.js";
import {
  chord,
  createBoard,
  createPreplacedBoard,
  ensureFirstClickSafe,
  minePositions,
  reveal,
  toggleFlag,
  type MineBoard,
} from "./logic.js";
import { generateMines } from "./generator.js";
import { computeAdjacent, type Opening } from "./solver.js";
import { el } from "../dom.js";

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
  const timerValue = el("mines-timer-value");
  /** Dynamically created pill showing remaining mines. Inserted into the meta-row. */
  const level = document.createElement("span");
  level.id = "mines-level";
  level.className = "meta-pill is-counter";
  level.setAttribute("aria-hidden", "true");
  const modeDailyBtn = el<HTMLButtonElement>("mines-mode-daily");
  const modeEndlessBtn = el<HTMLButtonElement>("mines-mode-endless");
  const modeSep = el("mines-mode-sep");
  // The pill must be a sibling of the toggle in the real meta-row: the toggle
  // floats centered over the board, so the pill pins to the top-right via the
  // row's space-between layout. modeDailyBtn.parentElement is the toggle div,
  // not the row.
  const metaRow = el("mines-mode").parentElement;
  if (metaRow) metaRow.appendChild(level);
  const gridWrap = el("mines-grid-wrap");
  const settingsPanel = el("mines-settings");
  const settingsToggle = el<HTMLButtonElement>("mines-settings-toggle");
  const regenBtn = el<HTMLButtonElement>("mines-regen");
  const viewToggle = el<HTMLButtonElement>("mines-view-toggle");
  const lbView = el("mines-lb-view");
  const setSizeInput = el<HTMLInputElement>("mines-set-size");
  const setMinesInput = el<HTMLInputElement>("mines-set-mines");

  /** Hold duration (ms) that turns a touch press into a flag toggle. */
  const LONG_PRESS_MS = 450;

  let board: MineBoard = createBoard();
  /** Seeded RNG for the active board (mine relocation on off-hint first clicks). */
  let boardRand: () => number = Math.random;
  /** Guaranteed no-guess opening for the active pre-generated board. */
  let openingHint: Opening | null = null;
  let started = false;
  /** UTC day key of the currently dealt daily board; re-deals at midnight rollover. */
  let dailyDay: string | null = null;
  const runTimer = createRunTimer();
  let resultReported = false;
  /** True once today's daily is finished (locks the board across reloads). */
  let dailyLocked = false;

  const endlessTimer = createRunTimer();
  /** Stashed per-mode play state; working vars above always mirror the active mode. */
  interface Slot {
    board: MineBoard;
    rand: () => number;
    opening: Opening | null;
    started: boolean;
    resultReported: boolean;
    day: string | null;
    timerLive: boolean;
  }
  let daily: Slot | null = null;
  let endless: Slot | null = null;

  // Restore boards persisted across reloads. The daily is bound to its UTC
  // day: a new day deals a new seed, so stored days other than today are
  // cleared and dropped (mount then deals a fresh board). `rand` is not
  // serializable and is only used for off-hint mine relocation, so a fresh
  // Math.random is fine on restore.
  {
    const today = todayUTC();
    const storedDaily = loadBoardState<MineStored>("minesweeper", "daily", isMineStored, today);
    if (storedDaily) {
      // Adjacent counts are derived from the mine layout, so recompute them
      // from the (authoritative) mines grid rather than trusting storage.
      const board = storedDaily.state.board;
      board.adjacent = computeAdjacent(board.mines, board.size);
      daily = {
        board,
        rand: Math.random,
        opening: storedDaily.state.opening,
        started: storedDaily.state.started,
        resultReported: storedDaily.state.resultReported,
        day: today,
        timerLive: storedDaily.timerLive,
      };
      runTimer.restoreElapsed(storedDaily.elapsedMs);
    }
    const storedEndless = loadBoardState<MineStored>("minesweeper", "endless", isMineStored, today);
    if (storedEndless) {
      const board = storedEndless.state.board;
      board.adjacent = computeAdjacent(board.mines, board.size);
      endless = {
        board,
        rand: Math.random,
        opening: storedEndless.state.opening,
        started: storedEndless.state.started,
        resultReported: storedEndless.state.resultReported,
        day: null,
        timerLive: storedEndless.timerLive,
      };
      endlessTimer.restoreElapsed(storedEndless.elapsedMs);
    }
  }

  function snapshot(): Slot | null {
    if (!started) return null;
    return {
      board,
      rand: boardRand,
      opening: openingHint,
      started,
      resultReported,
      day: dailyDay,
      timerLive: true,
    };
  }

  const modeShell: ModeShell = createModeShell<Slot>({
    id: "minesweeper",
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
      timerValue: "mines-timer-value",
    },
    dailyTimer: runTimer,
    endlessTimer,
    getSlot: (selectedMode) => selectedMode === "daily" ? daily : endless,
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
      buildGrid();
      paint();
      setStatus();
      modeShell.ensureDaily();
    },
    hasDaily: (day) => daily?.day === day,
    canResume: (): boolean => !(dailyLocked && modeShell.mode === "daily") && started && !board.over,
  });

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
        // Opening hint marking: daily only, until the first reveal.
        const showHint =
          modeShell.mode === "daily" &&
          !revealed &&
          !flagged &&
          !board.over &&
          board.revealedCount === 0 &&
          openingHint !== null &&
          r === openingHint.r &&
          c === openingHint.c;
        cell.classList.toggle("is-hint", showHint);
        cell.setAttribute(
          "aria-label",
          `Row ${r + 1}, column ${c + 1}, ${
            revealed ? (isMine ? "mine" : `${count} nearby`) : flagged ? "flagged" : "hidden"
          }${showHint ? ", hinted opening" : ""}`,
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
    modeShell.activeTimer().stop();
    timerValue.textContent = formatClock(modeShell.activeTimer().elapsed());
  }

  const pauseClock = modeShell.pauseClock;
  const resumeClock = modeShell.resumeClock;

  function onBoardToggle(detail: BoardDetail): void {
    if (detail.game !== "minesweeper") return;
    if (detail.showingBoard) pauseClock();
    // Resume only when the settings overlay is closed too.
    else if (settingsPanel.classList.contains("hidden")) resumeClock();
  }

  function onSettingsToggle(detail: SettingsDetail): void {
    if (detail.game !== "minesweeper") return;
    if (detail.settingsOpen) pauseClock();
    // Resume only when the leaderboard overlay is closed too.
    else if (lbView.classList.contains("hidden")) resumeClock();
  }

  /** Percent of safe cells revealed (100 when solved). */
  function clearedPercent(): number {
    const safe = Math.max(1, board.size * board.size - board.mineCount);
    return Math.max(0, Math.min(100, Math.round((board.revealedCount / safe) * 100)));
  }

  function setStatus(): void {
    if (dailyLocked && modeShell.mode === "daily") {
      const stored = loadDailyResult("minesweeper");
      if (stored) {
        const left = Math.max(0, board.mineCount - flaggedCount());
        level.textContent = left === 1 ? "1 mine" : `${left} mines`;
        message.textContent = dailyCompleteMessage();
        freezeClock();
        return;
      }
      dailyLocked = false;
    }
    const left = Math.max(0, board.mineCount - flaggedCount());
    level.textContent = left === 1 ? "1 mine" : `${left} mines`;
    if (board.over && board.won) {
      message.textContent =
        modeShell.mode === "daily" ? dailyCompleteMessage() : "Solved.";
      freezeClock();
    } else if (board.over) {
      message.textContent =
        modeShell.mode === "daily" ? dailyCompleteMessage() : "Game Over!";
      freezeClock();
    } else {
      message.textContent = "";
      return;
    }
    // Game over (solved or boom): one daily result, wins and losses alike.
    // revealedCount only tracks safe reveals (revealAllMines never touches
    // it), so the loss percent is exact here.
    if (!resultReported) {
      resultReported = true;
      // Endless results stay local: only daily results reach the leaderboard.
      if (modeShell.mode === "daily" && dailyDay !== null) {
        // Finishing the daily (either way) reveals endless for the day.
        setEndlessUnlocked("minesweeper", todayUTC());
        const durationMs = runTimer.elapsed();
        const score = board.won ? 100 : clearedPercent();
        announceResult({
          game: "minesweeper",
          durationMs,
          moves: board.revealedCount,
          score,
          won: board.won,
        });
        saveDailyResult("minesweeper", {
          day: dailyDay,
          won: board.won,
          score,
          durationMs,
          moves: board.revealedCount,
        });
        modeShell.paintMode();
      }
    }
  }

  /** Lock a finished daily so reloads keep the result instead of redealing play. */
  function refreshDailyLock(): void {
    dailyLocked =
      modeShell.mode === "daily" && dailyDay !== null && isDailyComplete("minesweeper", dailyDay);
    if (dailyLocked) {
      resultReported = true;
      modeShell.activeTimer().stop();
      setStatus();
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

  /** Deal the fixed daily board (pre-generated, guaranteed-solvable). */
  function dealDaily(day: string, seed: number): void {
    const rand = mulberry32(seed);
    const { mines, opening } = generateMines(9, 15, rand);
    const fresh = createPreplacedBoard(9, 15, mines);
    if (modeShell.mode !== "daily") {
      // Parked while endless is showing; timer starts on return to daily.
      daily = { board: fresh, rand, opening, started: true, resultReported: false, day, timerLive: false };
      return;
    }
    board = fresh;
    boardRand = rand;
    openingHint = opening;
    dailyDay = day;
    started = true;
    resultReported = false;
    dailyLocked = false;
    daily = { board, rand: boardRand, opening, started, resultReported, day, timerLive: true };
    runTimer.start();
    if (typeof document !== "undefined" && document.hidden) runTimer.pause();
    modeShell.bindTimerPill();
    clearPress();
    buildGrid();
    paint();
    setStatus();
    refreshDailyLock();
    persistActive();
  }

  /** Read settings inputs, clamp, persist, and echo the clamped values back. */
  function readSettings(): MinesEndlessSettings {
    const clamped = clampMinesSettings({
      size: setSizeInput.value,
      mines: setMinesInput.value,
    });
    saveEndlessSettings("minesweeper", clamped);
    setSizeInput.value = String(clamped.size);
    setMinesInput.value = String(clamped.mines);
    return clamped;
  }

  function fillSettingsInputs(s: MinesEndlessSettings): void {
    setSizeInput.value = String(s.size);
    setMinesInput.value = String(s.mines);
  }

  /** Persist the active board so a reload can restore it (played state only). */
  function persistActive(): void {
    const slot = snapshot();
    if (!slot) return;
    saveBoardState("minesweeper", modeShell.mode, {
      day: slot.day,
      elapsedMs: modeShell.activeTimer().elapsed(),
      timerLive: true,
      state: {
        board: slot.board,
        opening: slot.opening,
        started: slot.started,
        resultReported: slot.resultReported,
      },
    });
  }

  /** Deal a fresh endless board (pre-generated, guaranteed-solvable). */
  function dealEndless(): void {
    const s = readSettings();
    const { mines, opening } = generateMines(s.size, s.mines, Math.random);
    board = createPreplacedBoard(s.size, s.mines, mines);
    boardRand = Math.random;
    openingHint = opening;
    dailyDay = null;
    started = true;
    resultReported = false;
    endless = { board, rand: boardRand, opening, started, resultReported, day: null, timerLive: true };
    endlessTimer.start();
    if (typeof document !== "undefined" && document.hidden) endlessTimer.pause();
    modeShell.bindTimerPill();
    clearPress();
    buildGrid();
    paint();
    setStatus();
    persistActive();
  }

  /** Show the stored slot's board; start or resume its timer as appropriate. */
  function activateSlot(slot: Slot): void {
    board = slot.board;
    boardRand = slot.rand;
    openingHint = slot.opening;
    dailyDay = slot.day;
    started = slot.started;
    resultReported = slot.resultReported;
    dailyLocked = false;
    const timer = modeShell.activeTimer();
    modeShell.bindTimerPill();
    clearPress();
    buildGrid();
    paint();
    if (!slot.timerLive) {
      slot.timerLive = true;
      timer.start();
      if (typeof document !== "undefined" && document.hidden) timer.pause();
    } else if (!board.over) {
      timer.resume();
    }
    setStatus();
    refreshDailyLock();
  }


  function cellCoords(cell: HTMLElement): [number, number] | null {
    const r = Number(cell.dataset.row);
    const c = Number(cell.dataset.col);
    if (!Number.isInteger(r) || !Number.isInteger(c)) return null;
    return [r, c];
  }

  function flagCell(cell: HTMLElement): void {
    if (!started || board.over) return;
    if (dailyLocked && modeShell.mode === "daily") return;
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
    persistActive();
  }

  /** True when this cell was (un)flagged a moment ago by the other press path. */
  function recentlyFlagged(r: number, c: number): boolean {
    return recentFlagKey === `${r},${c}` && performance.now() - recentFlagAt < 700;
  }

  function activateCell(cell: HTMLElement): void {
    if (!started || board.over) return;
    if (dailyLocked && modeShell.mode === "daily") return;
    const coords = cellCoords(cell);
    if (!coords) return;
    const [r, c] = coords;
    if (board.state[r][c] === "flagged") {
      // Forgiving tap: tapping a flag removes it (long-press re-flags).
      toggleFlag(board, r, c);
    } else {
      const first = board.revealedCount === 0;
      // Pre-generated boards are placed; keep first-click-safe for players
      // who ignore the hint (guarantee then no longer applies).
      if (first && board.placed) ensureFirstClickSafe(board, r, c, boardRand);
      const hitMine = reveal(board, r, c, boardRand);
      if (hitMine) revealAllMines();
      paint();
      setStatus();
      cell.focus({ preventScroll: true });
      persistActive();
      return;
    }
    paint();
    setStatus();
    cell.focus({ preventScroll: true });
    persistActive();
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
    if (dailyLocked && modeShell.mode === "daily") return;
    const coords = cellCoords(cell);
    if (!coords) return;
    const hitMine = chord(board, coords[0], coords[1], boardRand);
    if (hitMine) revealAllMines();
    paint();
    setStatus();
    cell.focus({ preventScroll: true });
    persistActive();
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
  boardEvents.on(onBoardToggle);
  settingsEvents.on(onSettingsToggle);
  modeShell.attachListeners();
  setSizeInput.addEventListener("change", readSettings);
  setMinesInput.addEventListener("change", readSettings);
  fillSettingsInputs(loadEndlessSettings("minesweeper"));

  return {
    id: "minesweeper",
    mount(): void {
      root.classList.remove("hidden");
      document.getElementById("top")?.classList.add("has-result");
      if (modeShell.mode === "endless") {
        if (endless && endless.started) {
          paint();
          setStatus();
          resumeClock();
        } else {
          dealEndless();
        }
      } else if (!daily || !daily.started) {
        buildGrid();
        paint();
        setStatus();
        modeShell.ensureDaily();
      } else if (daily.day !== todayUTC()) {
        modeShell.ensureDaily();
      } else if (board !== daily.board) {
        // Freshly restored daily: sync the live globals to the stored slot.
        activateSlot(daily);
      } else {
        paint();
        setStatus();
        refreshDailyLock();
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
