import "../../index.css";
import { buildBoardGrid, paintBoard } from "./view.js";
import { solvePuzzle } from "./solver.js";
import { findHints } from "./hints.js";
import type { Hint } from "./hints.js";
import type { NormalizedPuzzle } from "./types.js";
import { nextMark } from "./marks.js";
import { generatePuzzle } from "./generator.js";
import type { GameInstance } from "../types.js";
import { formatClock, todayUTC } from "../../leaderboard/api.js";
import { announceWin, bindTimerPill, createRunTimer } from "../../leaderboard/report.js";
import { BOARD_EVENT, type BoardDetail } from "../../leaderboard/view.js";
import { fetchDailySeeds, mulberry32 } from "../daily.js";

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
const hintButton = el<HTMLButtonElement>("hint-button");
const hintMessage = el<HTMLParagraphElement>("hint-message");
const hintLevel = el("hint-level");
const undoButton = el<HTMLButtonElement>("undo-button");
const timerValue = el("crowns-timer-value");
const uploadSection = el("upload");
const solverSection = el("solver");

let puzzle: NormalizedPuzzle | null = null;
let fullSolution: string[][] | null = null;
let isWorking = false;
let availableHints: Hint[] = [];
const shownHints = new Set<string>();
let activeHint: Hint | null = null;
let undoStack: Array<{ r: number; c: number; prev: string }> = [];
let puzzleSolved = false;
/** UTC day key of the currently dealt board; re-deals at midnight rollover. */
let dailyDay: string | null = null;
const runTimer = createRunTimer();
/**
 * Whether availableHints holds fresh results for the current board.
 * Hints are computed lazily on Hint click (findHints runs a solver search
 * per unknown cell, far too slow to redo on every cell edit).
 */
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
  runTimer.stop();
  timerValue.textContent = formatClock(runTimer.elapsed());
}

/** Deal the fixed daily board (seed from server, generated client-side). */
function dealDaily(day: string, seed: number): void {
  if (isWorking) return;
  setPhase("working");
  isWorking = true;
  try {
    const generated = generatePuzzle(9, 2, 50, mulberry32(seed));
    const solved = solvePuzzle(generated);
    if (solved.status !== "solved" || !solved.solution) {
      showError("Could not deal today's puzzle.", solved.errors.join(" "));
      return;
    }
    puzzle = generated;
    fullSolution = solved.solution;
    availableHints = [];
    hintsComputed = false;
    shownHints.clear();
    activeHint = null;
    undoStack = [];
    puzzleSolved = false;
    dailyDay = day;
    hintMessage.textContent = "";
    hintLevel.textContent = "Daily";
    runTimer.start();
    if (typeof document !== "undefined" && document.hidden) runTimer.pause();
    bindTimerPill(runTimer, "crowns-timer-value", formatClock);
    buildBoardGrid(boardGrid, generated);
    paintBoard(boardGrid, generated, new Set(), null);
    boardGrid.setAttribute("aria-label", describeBoard());
    refreshHintButton();
    isWorking = false;
    setPhase("ready");
  } catch (e) {
    showError("Could not deal today's puzzle.", e instanceof Error ? e.message : "Try again.");
  }
}

function ensureDaily(): void {
  const day = todayUTC();
  if (puzzle && dailyDay === day) return;
  void fetchDailySeeds(day).then(({ day: seedDay, seeds }) => {
    if (puzzle && dailyDay === seedDay) return;
    dealDaily(seedDay, seeds.crowns);
  });
}

function showError(title: string, hint: string): void {
  errorTitle.textContent = title;
  errorHint.textContent = hint;
  isWorking = false;
  setPhase("error");
}

function refreshHintButton(): void {
  // Solved: both buttons park disabled. Daily has no New-puzzle action.
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
  hintMessage.textContent = "Solved.";
  hintLevel.textContent = "Daily";
  freezeClock();
  announceWin({
    game: "crowns",
    durationMs: runTimer.elapsed(),
    moves: undoStack.length,
    hintsUsed: shownHints.size,
  });
  paintBoard(boardGrid, puzzle, new Set(), null, puzzle.initial);  boardGrid.setAttribute("aria-label", describeBoard());
  refreshHintButton();
}

function undo(): void {
  if (!puzzle || undoStack.length === 0 || undoButton.disabled) return;
  const last = undoStack.pop()!;
  puzzle.initial[last.r][last.c] = last.prev;
  recomputeEditedBoard();
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
    hintLevel.textContent = "Daily";
  } else {
    hintMessage.textContent = "These marks cannot all be satisfied. Change a queen or cross to continue.";
    hintLevel.textContent = "Daily";
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
}

async function revealHint(): Promise<void> {
  if (!puzzle || !fullSolution || hintButton.disabled) return;
  if (!hintsComputed) {
    hintButton.disabled = true;
    hintMessage.textContent = "Thinking…";
    // Yield so the message paints before the blocking search runs.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The board may have changed while yielding (new daily dealt).
    if (!puzzle || !fullSolution) {
      refreshHintButton();
      return;
    }
    availableHints = findHints(puzzle);
    hintsComputed = true;
    if (availableHints.length === 0) {
      hintMessage.textContent = "No guaranteed deduction is available from the current board.";
      refreshHintButton();
      return;
    }
    hintMessage.textContent = "";
  }
  const next = availableHints.find((hint) => !shownHints.has(hintId(hint)));
  if (!next) {
    refreshHintButton();
    return;
  }
  activeHint = next;
  shownHints.add(hintId(next));
  hintMessage.textContent = next.text;
  hintLevel.textContent = next.difficultyLabel === "Advanced" ? "Daily" : `${next.difficultyLabel} · Daily`;
  paintBoard(boardGrid, puzzle, new Set(), activeHint);
  boardGrid.setAttribute("aria-label", describeBoard());
  refreshHintButton();
}

let listenersAttached = false;

function pauseClock(): void {
  runTimer.pause();
}

function resumeClock(): void {
  if (puzzle && !puzzleSolved) runTimer.resume();
}

function onBoardToggle(e: Event): void {
  const detail = (e as CustomEvent<BoardDetail>).detail;
  if (!detail || detail.game !== "crowns") return;
  if (detail.showingBoard) pauseClock();
  else resumeClock();
}

function attachListeners(): void {
  if (listenersAttached) return;
  listenersAttached = true;
  hintButton.addEventListener("click", () => void revealHint());
  undoButton.addEventListener("click", undo);
  window.addEventListener(BOARD_EVENT, onBoardToggle);
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

  setPhase("idle");
}

export function createCrownsGame(): GameInstance {
  attachListeners();
  return {
    id: "crowns",
    mount(): void {
      // Daily Challenge owns a fixed puzzle: the upload stage stays hidden.
      uploadSection.classList.add("hidden");
      solverSection.classList.remove("hidden");
      if (!puzzle) {
        setPhase("working");
        ensureDaily();
      } else if (dailyDay !== todayUTC()) {
        ensureDaily();
      } else {
        resumeClock();
      }
    },
    unmount(): void {
      pauseClock();
      uploadSection.classList.add("hidden");
      solverSection.classList.add("hidden");
    },
    pauseClock,
    resumeClock,
  };
}
