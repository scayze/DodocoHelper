import "../../index.css";
import { buildBoardGrid, paintBoard } from "./view.js";
import { solvePuzzle } from "./solver.js";
import { findHints } from "./hints.js";
import type { Hint } from "./hints.js";
import type { NormalizedPuzzle } from "./types.js";
import { nextMark } from "./marks.js";
import { generatePuzzle } from "./generator.js";
import { validatePuzzleInput } from "./validator.js";
import { extractBoardFromFile } from "./extract.js";
import type { GameInstance } from "../types.js";
import { formatClock, todayUTC } from "../../leaderboard/api.js";
import { announceWin, createRunTimer } from "../../leaderboard/report.js";
import { boardEvents, type BoardDetail } from "../../leaderboard/view.js";
import { dailyCompleteMessage, mulberry32 } from "../daily.js";
import {
  clampCrownsSettings,
  loadEndlessSettings,
  saveEndlessSettings,
  setEndlessUnlocked,
  type CrownsEndlessSettings,
} from "../mode.js";
import { createModeShell } from "../mode-shell.js";
import { loadBoardState, saveBoardState } from "../persist.js";
import { isCrownsStored, type CrownsStored } from "./stored.js";

type Phase = "idle" | "working" | "ready" | "error";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const panels = {
  working: el("panel-working"),
  ready: el("panel-ready"),
  error: el("panel-error"),
};
const resultArea = el("result-area");
const errorTitle = el("error-title");
const errorHint = el("error-hint");
const boardGrid = el("board-grid");
const workingMessage = el("working-message");

function setWorkingMessage(text: string): void {
  workingMessage.textContent = text;
}
const hintButton = el<HTMLButtonElement>("hint-button");
const hintMessage = el<HTMLParagraphElement>("hint-message");
const undoButton = el<HTMLButtonElement>("undo-button");
const timerValue = el("crowns-timer-value");
const solverSection = el("solver");
const modeDailyBtn = el<HTMLButtonElement>("crowns-mode-daily");
const modeEndlessBtn = el<HTMLButtonElement>("crowns-mode-endless");
const modeSep = el("crowns-mode-sep");
const settingsPanel = el("crowns-settings");
const settingsToggle = el<HTMLButtonElement>("crowns-settings-toggle");
const regenBtn = el<HTMLButtonElement>("crowns-regen");
const viewToggle = el<HTMLButtonElement>("crowns-view-toggle");
const lbView = el("crowns-lb-view");
const setSizeInput = el<HTMLInputElement>("crowns-set-size");
const screenshotBtn = el<HTMLButtonElement>("crowns-screenshot");
const fileInput = el<HTMLInputElement>("crowns-file-input");

let puzzle: NormalizedPuzzle | null = null;
let fullSolution: string[][] | null = null;
let isWorking = false;
let availableHints: Hint[] = [];
let shownHints = new Set<string>();
let activeHint: Hint | null = null;
let undoStack: Array<{ r: number; c: number; prev: string }> = [];
let puzzleSolved = false;
/** UTC day key of the currently dealt daily board; re-deals at midnight rollover. */
let dailyDay: string | null = null;
const runTimer = createRunTimer();

const endlessTimer = createRunTimer();
let readingShot = false;
/** Stashed per-mode play state; working vars above always mirror the active mode. */
interface Slot {
  puzzle: NormalizedPuzzle;
  solution: string[][];
  undo: Array<{ r: number; c: number; prev: string }>;
  solved: boolean;
  day: string | null;
  timerLive: boolean;
}
let daily: Slot | null = null;
let endless: Slot | null = null;

/** Rebuild a full slot from its stored slice (day/timer from envelope). */
function storedCrownsSlot(raw: CrownsStored, day: string | null, timerLive: boolean): Slot {
  return {
    puzzle: raw.puzzle,
    solution: raw.solution,
    undo: raw.undo,
    solved: raw.solved,
    day,
    timerLive,
  };
}

function snapshot(): Slot | null {
  if (!puzzle || !fullSolution) return null;
  return {
    puzzle,
    solution: fullSolution,
    undo: [...undoStack],
    solved: puzzleSolved,
    day: dailyDay,
    timerLive: true,
  };
}

const modeShell = createModeShell<Slot>({
  id: "crowns",
  elements: {
    modeDaily: modeDailyBtn,
    modeEndless: modeEndlessBtn,
    modeSeparator: modeSep,
    settings: settingsPanel,
    settingsToggle,
    regenerate: regenBtn,
    viewToggle,
    leaderboardView: lbView,
    timerValue: "crowns-timer-value",
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
  restoreSlot,
  dealDaily,
  dealEndless,
  onEmptyDaily: () => {
    puzzle = null;
    fullSolution = null;
    setWorkingMessage("Dealing today’s puzzle…");
    setPhase("working");
    modeShell.ensureDaily();
  },
  hasDaily: (day) => daily?.day === day,
  canResume: () => puzzle !== null && !puzzleSolved,
});

/** Whether availableHints holds fresh results for the current board.
 * Hints are computed lazily on Hint click and are never persisted: after a
 * reload the first click recomputes them, so the shown-hints history restarts. */
let hintsComputed = false;

function focusPanel(id: string): void {
  const node = document.getElementById(id);
  node?.focus({ preventScroll: true });
}

function setPhase(phase: Phase): void {
  resultArea.classList.toggle("hidden", phase === "idle");
  for (const [name, panel] of Object.entries(panels)) {
    panel.classList.toggle("hidden", name !== phase);
  }
  document.getElementById("top")?.classList.toggle("has-result", phase !== "idle");
  if (phase === "ready") focusPanel("panel-ready");
  if (phase === "error") focusPanel("panel-error");
}

function freezeClock(): void {
  modeShell.activeTimer().stop();
  timerValue.textContent = formatClock(modeShell.activeTimer().elapsed());
}

/** Persist the active board so a reload can restore it (played state only). */
function persistActive(): void {
  const slot = snapshot();
  if (!slot) return;
  saveBoardState("crowns", modeShell.mode, {
    day: slot.day,
    elapsedMs: modeShell.activeTimer().elapsed(),
    timerLive: true,
    state: {
      puzzle: slot.puzzle,
      solution: slot.solution,
      undo: slot.undo,
      solved: slot.solved,
    },
  });
}

/** Put a solved board into play for the active mode; restarts that mode's clock. */
function applyBoard(next: NormalizedPuzzle, solution: string[][], day: string | null): void {
  puzzle = next;
  fullSolution = solution;
  availableHints = [];
  hintsComputed = false;
  shownHints = new Set<string>();
  activeHint = null;
  undoStack = [];
  puzzleSolved = false;
  dailyDay = day;
  const slot = snapshot();
  if (modeShell.mode === "daily") daily = slot;
  else endless = slot;
  hintMessage.textContent = "";
  const timer = modeShell.activeTimer();
  timer.start();
  if (typeof document !== "undefined" && document.hidden) timer.pause();
  modeShell.bindTimerPill();
  buildBoardGrid(boardGrid, next);
  paintBoard(boardGrid, next, new Set(), null);
  boardGrid.setAttribute("aria-label", describeBoard());
  refreshHintButton();
  isWorking = false;
  setPhase("ready");
  persistActive();
}

/** Deal the fixed daily board (seed from server, generated client-side). */
function dealDaily(day: string, seed: number): void {
  if (isWorking) return;
  let generated: NormalizedPuzzle;
  let solution: string[][];
  try {
    generated = generatePuzzle(9, 2, 1200, mulberry32(seed));
    const solved = solvePuzzle(generated);
    if (solved.status !== "solved" || !solved.solution) {
      if (modeShell.mode === "daily") showError("Could not deal today's puzzle.", solved.errors.join(" "));
      return;
    }
    solution = solved.solution;
  } catch (e) {
    if (modeShell.mode === "daily") {
      showError("Could not deal today's puzzle.", e instanceof Error ? e.message : "Try again.");
    }
    return;
  }
  if (modeShell.mode !== "daily") {
    // Parked while endless is showing; timer starts on return to daily.
    daily = {
      puzzle: generated,
      solution,
      undo: [],
      solved: false,
      day,
      timerLive: false,
    };
    return;
  }
  setWorkingMessage("Dealing today’s puzzle…");
  setPhase("working");
  isWorking = true;
  applyBoard(generated, solution, day);
}

/** Read settings inputs, clamp, persist, and echo the clamped values back. */
function readSettings(): CrownsEndlessSettings {
  const clamped = clampCrownsSettings({ size: setSizeInput.value });
  saveEndlessSettings("crowns", clamped);
  setSizeInput.value = String(clamped.size);
  return clamped;
}

function fillSettingsInputs(s: CrownsEndlessSettings): void {
  setSizeInput.value = String(s.size);
}

/** Deal a fresh endless board from the current settings; restarts the endless clock. */
function dealEndless(): void {
  if (isWorking || readingShot) return;
  const s = readSettings();
  setWorkingMessage("Dealing a pure-logic board…");
  setPhase("working");
  isWorking = true;
  try {
    const generated = generatePuzzle(s.size, 2, 1200, Math.random);
    const solved = solvePuzzle(generated);
    if (solved.status !== "solved" || !solved.solution) {
      hintMessage.textContent = "Could not find a pure-logic board — try different settings.";
      isWorking = false;
      setPhase("ready");
      return;
    }
    applyBoard(generated, solved.solution, null);
  } catch {
    hintMessage.textContent = "Could not find a pure-logic board — try different settings.";
    isWorking = false;
    setPhase("ready");
  }
}

/** Load a screenshot board (from settings) as the endless board. */
function dealScreenshot(file: File): void {
  if (modeShell.mode !== "endless" || isWorking || readingShot) return;
  readingShot = true;
  regenBtn.disabled = true;
  hintMessage.textContent = "Reading screenshot…";
  void extractBoardFromFile(file)
    .then((res) => {
      if (modeShell.mode !== "endless") return;
      if (!res.ok || !res.puzzle) {
        hintMessage.textContent = `Could not read that image (${res.error ?? "no board found"}).`;
        return;
      }
      const checked = validatePuzzleInput(res.puzzle);
      if (!checked.puzzle) {
        hintMessage.textContent = `That image didn't parse (${checked.errors.join(" ")}).`;
        return;
      }
      const solved = solvePuzzle(checked.puzzle);
      if (solved.status !== "solved" || !solved.solution) {
        hintMessage.textContent = `No solution for that board (${solved.errors.join(" ")}).`;
        return;
      }
      applyBoard(checked.puzzle, solved.solution, null);
    })
    .catch((e: unknown) => {
      if (modeShell.mode === "endless") {
        hintMessage.textContent = `Could not read that image (${e instanceof Error ? e.message : "try again"}).`;
      }
    })
    .finally(() => {
      readingShot = false;
      regenBtn.disabled = false;
    });
}

/** Show the stored slot's board; start or resume its timer as appropriate. */
function restoreSlot(slot: Slot): void {
  puzzle = slot.puzzle;
  fullSolution = slot.solution;
  // Hint state is runtime-only: recompute lazily on the next Hint click.
  availableHints = [];
  hintsComputed = false;
  shownHints = new Set();
  activeHint = null;
  undoStack = [...slot.undo];
  puzzleSolved = slot.solved;
  dailyDay = slot.day;
  const timer = modeShell.activeTimer();
  modeShell.bindTimerPill();
  buildBoardGrid(boardGrid, slot.puzzle);
  paintBoard(boardGrid, slot.puzzle, new Set(), null, slot.puzzle.initial);
  boardGrid.setAttribute("aria-label", describeBoard());
  hintMessage.textContent = slot.solved
    ? modeShell.mode === "daily"
      ? dailyCompleteMessage()
      : "Solved."
    : "";
  if (!slot.timerLive) {
    slot.timerLive = true;
    timer.start();
    if (typeof document !== "undefined" && document.hidden) timer.pause();
  } else if (!slot.solved) {
    timer.resume();
  } else {
    timerValue.textContent = formatClock(timer.elapsed());
  }
  refreshHintButton();
  setPhase("ready");
}


function showError(title: string, hint: string): void {
  errorTitle.textContent = title;
  errorHint.textContent = hint;
  isWorking = false;
  setPhase("error");
}

function refreshHintButton(): void {
  // Solved: both buttons park disabled. Daily has no New-puzzle action (endless uses Regenerate).
  if (puzzleSolved) {
    hintButton.disabled = true;
    undoButton.disabled = true;
    return;
  }
  if (!fullSolution) {
    hintButton.disabled = true;
    undoButton.disabled = undoStack.length === 0;
    return;
  }
  // Hints are computed lazily: assume hints may exist until proven otherwise.
  if (!hintsComputed) {
    hintButton.disabled = false;
    undoButton.disabled = undoStack.length === 0;
    return;
  }
  const left = availableHints.filter((hint) => !shownHints.has(hintId(hint))).length;
  hintButton.disabled = left === 0;
  undoButton.disabled = undoStack.length === 0;
  if (left === 0 && shownHints.size === 0 && availableHints.length === 0) {
    hintMessage.textContent = "No guaranteed deduction is available from the current board.";
  }
}

/** Check whether the player's crowns match the solution. */
function checkPlaySolved(): void {
  if (!puzzle || !fullSolution || puzzleSolved) return;
  for (let r = 0; r < puzzle.size; r++) {
    for (let c = 0; c < puzzle.size; c++) {
      const isCrown = fullSolution[r][c] === "C";
      if (isCrown && puzzle.initial[r][c] !== "C") return;
      if (!isCrown && puzzle.initial[r][c] === "C") return;
    }
  }
  puzzleSolved = true;
  activeHint = null;
  hintMessage.textContent =
    modeShell.mode === "daily" ? dailyCompleteMessage() : "Solved.";
  freezeClock();
  // Endless wins stay local: only daily wins reach the leaderboard.
  if (modeShell.mode === "daily") {
    // Solving the daily reveals the endless button (rest of the day).
    setEndlessUnlocked("crowns", todayUTC());
    announceWin({
      game: "crowns",
      durationMs: runTimer.elapsed(),
      moves: undoStack.length,
      hintsUsed: shownHints.size,
    });
    modeShell.paintMode();
  }
  paintBoard(boardGrid, puzzle, new Set(), null, puzzle.initial);  boardGrid.setAttribute("aria-label", describeBoard());
  refreshHintButton();
}

function undo(): void {
  if (!puzzle || undoStack.length === 0 || undoButton.disabled) return;
  const last = undoStack.pop()!;
  puzzle.initial[last.r][last.c] = last.prev;
  recomputeEditedBoard();
  persistActive();
}

function hintId(hint: Hint): string {
  return `${hint.kind}:${hint.scope}:${hint.cells.join(";")}:${hint.decisiveCells.join(";")}`;
}

function describeBoard(): string {
  if (!puzzle) return "Puzzle board with regions, marks, and crowns";
  const placed = fullSolution?.flat().filter((v) => v === "C").length ??
    puzzle.initial.flat().filter((v) => v === "C").length;
  const shown = shownHints.size;
  const highlight = activeHint ? `, highlighted ${activeHint.scope}` : "";
  return `Puzzle board, ${puzzle.size} by ${puzzle.size}, ${placed} crowns total, ${shown} hints shown${highlight}`;
}

function recomputeEditedBoard(): void {
  if (!puzzle) return;
  const solved = solvePuzzle(puzzle);
  fullSolution = solved.status === "solved" ? solved.solution : null;
  // Invalidate the hint cache; hints are recomputed lazily on Hint click
  // because findHints runs a solver search per unknown cell.
  availableHints = [];
  hintsComputed = false;
  shownHints.clear();
  activeHint = null;
  paintBoard(boardGrid, puzzle, new Set(), null, puzzle.initial);
  boardGrid.setAttribute("aria-label", describeBoard());
  if (fullSolution) {
    hintMessage.textContent = "";
  } else {
    hintMessage.textContent = "These marks cannot all be satisfied. Change a queen or cross to continue.";
  }
  refreshHintButton();
}

function editCell(cell: HTMLElement): void {
  if (!puzzle) return;
  if (puzzleSolved) return;
  const r = Number(cell.dataset.row);
  const c = Number(cell.dataset.col);
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= puzzle.size || c >= puzzle.size) return;
  undoStack.push({ r, c, prev: puzzle.initial[r][c] });
  puzzle.initial[r][c] = nextMark(puzzle.initial[r][c]);
  recomputeEditedBoard();
  checkPlaySolved();
  cell.focus({ preventScroll: true });
  persistActive();
}

function revealHint(): void {
  if (!puzzle || !fullSolution || hintButton.disabled) return;
  if (!hintsComputed) {
    availableHints = findHints(puzzle);
    hintsComputed = true;
    if (availableHints.length === 0) {
      hintMessage.textContent = "No guaranteed deduction is available from the current board.";
      refreshHintButton();
      persistActive();
      return;
    }
    hintMessage.textContent = "";
    persistActive();
  }
  const next = availableHints.find((hint) => !shownHints.has(hintId(hint)));
  if (!next) {
    refreshHintButton();
    return;
  }
  activeHint = next;
  shownHints.add(hintId(next));
  hintMessage.textContent = next.text;
  paintBoard(boardGrid, puzzle, new Set(), activeHint);
  boardGrid.setAttribute("aria-label", describeBoard());
  refreshHintButton();
  persistActive();
}

let listenersAttached = false;

const pauseClock = modeShell.pauseClock;
const resumeClock = modeShell.resumeClock;

function onBoardToggle(detail: BoardDetail): void {
  if (detail.game !== "crowns") return;
  if (detail.showingBoard) pauseClock();
  else resumeClock();
}

function attachListeners(): void {
  if (listenersAttached) return;
  listenersAttached = true;
  hintButton.addEventListener("click", revealHint);
  undoButton.addEventListener("click", undo);
  boardEvents.on(onBoardToggle);
  boardGrid.addEventListener("click", (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-row][data-col]");
    if (cell && boardGrid.contains(cell)) editCell(cell);
  });
  boardGrid.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-row][data-col]");
    if (!cell || !boardGrid.contains(cell)) return;
    e.preventDefault();
    editCell(cell);
  });

  // Static 9x9 loading skeleton.
  {
    const grid = el("skeleton-grid");
    for (let i = 0; i < 81; i++) {
      const cell = document.createElement("div");
      cell.className = "skeleton-cell aspect-square rounded-md bg-night-700";
      grid.appendChild(cell);
    }
  }

  modeShell.attachListeners();
  setSizeInput.addEventListener("change", readSettings);
  screenshotBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file) dealScreenshot(file);
  });
  fillSettingsInputs(loadEndlessSettings("crowns"));

  setPhase("idle");
}

export function createCrownsGame(): GameInstance {
  attachListeners();
  // Restore boards persisted locally across reloads. The daily board is
  // bound to its UTC day: a new day deals a new seed, so a stored day other
  // than today is cleared and dropped (mount then deals a fresh board).
  {
    const today = todayUTC();
    const storedDaily = loadBoardState<CrownsStored>("crowns", "daily", isCrownsStored, today);
    if (storedDaily) {
      daily = storedCrownsSlot(storedDaily.state, today, storedDaily.timerLive);
      runTimer.restoreElapsed(storedDaily.elapsedMs);
    }
    const storedEndless = loadBoardState<CrownsStored>("crowns", "endless", isCrownsStored, today);
    if (storedEndless) {
      endless = storedCrownsSlot(storedEndless.state, null, storedEndless.timerLive);
      endlessTimer.restoreElapsed(storedEndless.elapsedMs);
    }
  }
  return {
    id: "crowns",
    mount(): void {
      solverSection.classList.remove("hidden");
      if (modeShell.mode === "daily" && daily && daily.day !== todayUTC()) {
        // Midnight rollover: the in-memory daily belongs to yesterday's seed.
        daily = null;
      }
      const slot = modeShell.mode === "daily" ? daily : endless;
      if (slot) {
        restoreSlot(slot);
      } else if (modeShell.mode === "endless") {
        dealEndless();
      } else {
        setWorkingMessage("Dealing today’s puzzle…");
        setPhase("working");
        modeShell.ensureDaily();
      }
      modeShell.paintMode();
    },
    unmount(): void {
      pauseClock();
      solverSection.classList.add("hidden");
    },
    pauseClock,
    resumeClock,
  };
}
