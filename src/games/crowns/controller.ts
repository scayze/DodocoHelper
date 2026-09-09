import "../../index.css";
import { extractBoardFromFile } from "./extract.js";
import { buildBoardGrid, paintBoard } from "./view.js";
import { solvePuzzle } from "./solver.js";
import { findHints } from "./hints.js";
import type { Hint } from "./hints.js";
import { validatePuzzleInput } from "./validator.js";
import type { NormalizedPuzzle, PuzzleInput } from "./types.js";
import { nextMark } from "./marks.js";
import { generatePuzzle } from "./generator.js";
import type { GameInstance } from "../types.js";
import { announceWin, createRunTimer } from "../../leaderboard/report.js";

type Phase = "idle" | "working" | "ready" | "error";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

/** Whether the crowns game is the currently visible tab. Upload/paste is ignored otherwise. */
let crownsActive = false;

export function setCrownsActive(active: boolean): void {
  crownsActive = active;
}

const screenshotButton = el<HTMLButtonElement>("screenshot-button");
const generateButton = el<HTMLButtonElement>("generate-button");
const fileInput = el<HTMLInputElement>("file-input");
const panels = {
  working: el("panel-working"),
  ready: el("panel-ready"),
  error: el("panel-error"),
};
const resultArea = el("result-area");
const errorTitle = el("error-title");
const errorHint = el("error-hint");
const retryButton = el<HTMLButtonElement>("retry-button");
const boardGrid = el("board-grid");
const hintButton = el<HTMLButtonElement>("hint-button");
const hintLabel = el("hint-label");
const hintMessage = el<HTMLParagraphElement>("hint-message");
const hintLevel = el<HTMLParagraphElement>("hint-level");
const undoButton = el<HTMLButtonElement>("undo-button");
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

function handleNewPuzzle(): void {
  if (isWorking) return;
  setPhase("working");
  isWorking = true;
  try {
    const generated = generatePuzzle();
    const solved = solvePuzzle(generated);
    if (solved.status !== "solved" || !solved.solution) {
      showError("Could not generate a puzzle.", solved.errors.join(" "));
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
    hintMessage.textContent = "";
    hintLevel.textContent = "";
    runTimer.start();
    buildBoardGrid(boardGrid, generated);
    paintBoard(boardGrid, generated, new Set(), null);
    boardGrid.setAttribute("aria-label", describeBoard());
    refreshHintButton();
    isWorking = false;
    setPhase("ready");
  } catch (e) {
    showError("Could not generate a puzzle.", e instanceof Error ? e.message : "Try again.");
  }
}

function showError(title: string, hint: string): void {
  errorTitle.textContent = title;
  errorHint.textContent = hint;
  isWorking = false;
  setPhase("error");
}

function refreshHintButton(): void {
  // A solved puzzle turns the Hint button into a New puzzle button.
  if (puzzleSolved) {
    hintLabel.textContent = "New puzzle";
    hintButton.disabled = false;
    undoButton.disabled = true;
    return;
  }
  hintLabel.textContent = "Hint";
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
  hintLevel.textContent = "";
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

function runPuzzle(raw: PuzzleInput): void {
  const { errors, puzzle: parsed } = validatePuzzleInput(raw);
  if (!parsed) {
    showError("That board did not pass validation.", errors.join(" "));
    return;
  }
  const solved = solvePuzzle(raw);
  if (solved.status !== "solved" || !solved.solution) {
    showError("No crowns fit that board.", solved.errors.join(" "));
    return;
  }
  puzzle = parsed;
  fullSolution = solved.solution;
  availableHints = [];
  hintsComputed = false;
  shownHints.clear();
  activeHint = null;
  undoStack = [];
  puzzleSolved = false;
  hintMessage.textContent = "";
  hintLevel.textContent = "";
  runTimer.start();
  buildBoardGrid(boardGrid, parsed);
  paintBoard(boardGrid, parsed, new Set(), null);
  boardGrid.setAttribute("aria-label", describeBoard());
  refreshHintButton();
  isWorking = false;
  setPhase("ready");
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
    hintLevel.textContent = "";
  } else {
    hintMessage.textContent = "These marks cannot all be satisfied. Change a queen or cross to continue.";
    hintLevel.textContent = "";
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

async function onHintButton(): Promise<void> {
  if (puzzleSolved) {
    handleNewPuzzle();
    return;
  }
  await revealHint();
}

async function revealHint(): Promise<void> {
  if (!puzzle || !fullSolution || hintButton.disabled) return;
  if (!hintsComputed) {
    hintButton.disabled = true;
    hintMessage.textContent = "Thinking…";
    // Yield so the message paints before the blocking search runs.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The board may have changed while yielding (new puzzle started).
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
  hintLevel.textContent = next.difficultyLabel === "Advanced" ? "" : `${next.difficultyLabel} hint`;
  paintBoard(boardGrid, puzzle, new Set(), activeHint);
  boardGrid.setAttribute("aria-label", describeBoard());
  refreshHintButton();
}

async function handleFile(file: File): Promise<void> {
  if (!crownsActive || isWorking) return;
  if (!file.type.startsWith("image/")) {
    showError("Please upload an image file.", "PNG or JPEG shots of the puzzle board work best.");
    return;
  }
  setPhase("working");
  isWorking = true;
  try {
    const extracted = await extractBoardFromFile(file);
    if (!extracted.ok || !extracted.puzzle) {
      showError(
        "The grid reader could not map that shot.",
        extracted.error ?? "Keep the whole board visible with the grid clearly shown.",
      );
      return;
    }
    runPuzzle(extracted.puzzle);
  } catch (e) {
    showError(
      "That image could not be read.",
      e instanceof Error ? e.message : "Please try a different file.",
    );
  }
}

/** First image file on the clipboard, or null when no image was pasted. */
function clipboardImage(e: ClipboardEvent): File | null {
  const files = e.clipboardData?.files;
  if (!files) return null;
  for (const file of Array.from(files)) {
    if (file.type.startsWith("image/")) return file;
  }
  return null;
}

function setDragOver(on: boolean): void {
  screenshotButton.classList.toggle("drop-active", on);
}

let listenersAttached = false;

function attachListeners(): void {
  if (listenersAttached) return;
  listenersAttached = true;
  screenshotButton.addEventListener("click", () => fileInput.click());
  generateButton.addEventListener("click", () => handleNewPuzzle());
  uploadSection.addEventListener("dragover", (e) => {
    if (!crownsActive) return;
    e.preventDefault();
    setDragOver(true);
  });
  uploadSection.addEventListener("dragleave", () => setDragOver(false));
  uploadSection.addEventListener("drop", (e) => {
    if (!crownsActive) return;
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) void handleFile(file);
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) void handleFile(file);
    fileInput.value = "";
  });
  // Paste-to-upload: Ctrl+V anywhere on the page with an image on the clipboard.
  document.addEventListener("paste", (e) => {
    if (!crownsActive) return;
    const file = clipboardImage(e);
    if (!file) return;
    e.preventDefault();
    void handleFile(file);
  });
  retryButton.addEventListener("click", () => fileInput.click());
  hintButton.addEventListener("click", onHintButton);
  undoButton.addEventListener("click", undo);
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
      setCrownsActive(true);
      uploadSection.classList.remove("hidden");
      solverSection.classList.remove("hidden");
    },
    unmount(): void {
      setCrownsActive(false);
      uploadSection.classList.add("hidden");
      solverSection.classList.add("hidden");
    },
  };
}
