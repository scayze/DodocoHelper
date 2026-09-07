import "./index.css";
import { extractBoardFromFile } from "./lib/extract";
import { buildBoardGrid, paintBoard, solutionCrowns } from "./lib/renderBoard";
import { solvePuzzle } from "./core/solver.js";
import { validatePuzzleInput } from "./core/validator.js";
import type { NormalizedPuzzle, PuzzleInput } from "./core/types.js";

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

let puzzle: NormalizedPuzzle | null = null;
let fullSolution: string[][] | null = null;
let isWorking = false;
const hinted = new Set<string>();

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

function hintedCount(p: NormalizedPuzzle, solution: string[][]): number {
  let n = 0;
  for (let r = 0; r < p.size; r++) {
    for (let c = 0; c < p.size; c++) {
      if (solution[r][c] === "C" && p.initial[r][c] !== "C" && !hinted.has(`${r},${c}`)) n++;
    }
  }
  return n;
}

function refreshHintButton(): void {
  if (!puzzle || !fullSolution) return;
  const left = hintedCount(puzzle, fullSolution);
  hintLabel.textContent = left > 0 ? `Hint (${left} left)` : "Hint";
  hintButton.disabled = left === 0;
}

function describeBoard(): string {
  if (!puzzle || !fullSolution) return "Puzzle board with regions, marks, and crowns";
  const placed = fullSolution.flat().filter((v) => v === "C").length;
  const shown = hinted.size;
  return `Puzzle board, ${puzzle.size} by ${puzzle.size}, ${placed} crowns total, ${shown} hints shown`;
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
  hinted.clear();
  solveButton.disabled = false;
  solveButton.textContent = "Solve";
  buildBoardGrid(boardGrid, parsed);
  paintBoard(boardGrid, parsed, new Set());
  boardGrid.setAttribute("aria-label", describeBoard());
  refreshHintButton();
  isWorking = false;
  setPhase("ready");
}

function revealHint(): void {
  if (!puzzle || !fullSolution || hintButton.disabled) return;
  outer: for (let r = 0; r < puzzle.size; r++) {
    for (let c = 0; c < puzzle.size; c++) {
      if (fullSolution[r][c] === "C" && puzzle.initial[r][c] !== "C" && !hinted.has(`${r},${c}`)) {
        hinted.add(`${r},${c}`);
        break outer;
      }
    }
  }
  paintBoard(boardGrid, puzzle, hinted);
  boardGrid.setAttribute("aria-label", describeBoard());
  refreshHintButton();
}

function revealSolution(): void {
  if (!puzzle || !fullSolution || solveButton.disabled) return;
  paintBoard(boardGrid, puzzle, solutionCrowns(fullSolution));
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
  dropzoneTitle.textContent = on ? "Drop it to solve" : "Drag a screenshot, paste it, or click to browse";
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
