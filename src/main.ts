import "./index.css";
import { extractBoardFromFile } from "./lib/extract";
import { buildBoardGrid, paintBoard, solutionCrowns } from "./lib/renderBoard";
import { solvePuzzle } from "./core/solver.js";
import { findHints } from "./core/hints.js";
import type { Hint } from "./core/hints.js";
import { validatePuzzleInput } from "./core/validator.js";
import type { NormalizedPuzzle, PuzzleInput } from "./core/types.js";
import { nextMark } from "./core/marks.js";

type Phase = "idle" | "working" | "ready" | "error";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const dropzone = el<HTMLDivElement>("dropzone");
const dropzoneTitle = el<HTMLParagraphElement>("dropzone-title");
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
const solveButton = el<HTMLButtonElement>("solve-button");
const hintButton = el<HTMLButtonElement>("hint-button");
const hintLabel = el("hint-label");
const hintMessage = el<HTMLParagraphElement>("hint-message");
const hintLevel = el<HTMLParagraphElement>("hint-level");

let puzzle: NormalizedPuzzle | null = null;
let fullSolution: string[][] | null = null;
let isWorking = false;
let availableHints: Hint[] = [];
const shownHints = new Set<string>();
let activeHint: Hint | null = null;

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

function showError(title: string, hint: string): void {
  errorTitle.textContent = title;
  errorHint.textContent = hint;
  isWorking = false;
  setPhase("error");
}

function refreshHintButton(): void {
  if (!fullSolution) {
    hintLabel.textContent = "Hint";
    hintButton.disabled = true;
    return;
  }
  const left = availableHints.filter((hint) => !shownHints.has(hintId(hint))).length;
  hintLabel.textContent = left > 0 ? `Hint (${left} left)` : "Hint";
  hintButton.disabled = left === 0;
  if (left === 0 && shownHints.size === 0 && availableHints.length === 0) {
    hintMessage.textContent = "No guaranteed deduction is available from the current board.";
  }
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
  availableHints = findHints(parsed);
  shownHints.clear();
  activeHint = null;
  hintMessage.textContent = "";
  hintLevel.textContent = "";
  solveButton.disabled = false;
  solveButton.textContent = "Solve";
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
  availableHints = fullSolution ? findHints(puzzle) : [];
  shownHints.clear();
  activeHint = null;
  paintBoard(boardGrid, puzzle, new Set(), null, puzzle.initial);
  boardGrid.setAttribute("aria-label", describeBoard());
  solveButton.disabled = !fullSolution;
  solveButton.textContent = fullSolution ? "Solve" : "No solution";
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
  const r = Number(cell.dataset.row);
  const c = Number(cell.dataset.col);
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= puzzle.size || c >= puzzle.size) return;
  puzzle.initial[r][c] = nextMark(puzzle.initial[r][c]);
  recomputeEditedBoard();
  cell.focus({ preventScroll: true });
}

function revealHint(): void {
  if (!puzzle || !fullSolution || hintButton.disabled) return;
  const next = availableHints.find((hint) => !shownHints.has(hintId(hint)));
  if (!next) return;
  activeHint = next;
  shownHints.add(hintId(next));
  hintMessage.textContent = next.text;
  hintLevel.textContent = next.difficultyLabel === "Advanced" ? "" : `${next.difficultyLabel} hint`;
  paintBoard(boardGrid, puzzle, new Set(), activeHint);
  boardGrid.setAttribute("aria-label", describeBoard());
  refreshHintButton();
}

function revealSolution(): void {
  if (!puzzle || !fullSolution || solveButton.disabled) return;
  activeHint = null;
  hintMessage.textContent = "";
  hintLevel.textContent = "";
  paintBoard(boardGrid, puzzle, solutionCrowns(fullSolution), null, puzzle.initial);
  boardGrid.setAttribute("aria-label", `Solved puzzle board, ${puzzle.size} by ${puzzle.size}`);
  solveButton.disabled = true;
  solveButton.textContent = "Solved";
  hintButton.disabled = true;
}

async function handleFile(file: File): Promise<void> {
  if (isWorking) return;
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
  dropzone.classList.toggle("drop-active", on);
  dropzone.classList.toggle("border-gold-500", on);
  dropzoneTitle.textContent = on ? "Drop it" : "Drag a screenshot, paste it, or click to browse";
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  setDragOver(true);
});
dropzone.addEventListener("dragleave", () => setDragOver(false));
dropzone.addEventListener("drop", (e) => {
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
  const file = clipboardImage(e);
  if (!file) return;
  e.preventDefault();
  void handleFile(file);
});
retryButton.addEventListener("click", () => fileInput.click());
solveButton.addEventListener("click", revealSolution);
hintButton.addEventListener("click", revealHint);
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
