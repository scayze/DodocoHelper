import type { GameInstance } from "../types.js";
import {
  checkWin,
  createBoard,
  generateLevel,
  tentsInCol,
  tentsInRow,
  totalTents,
  tentsPlaced,
  toggleMark,
  type TentsBoard,
} from "./logic.js";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

export function createTentsGame(): GameInstance {
  const root = el("tents");
  const grid = el("tents-grid");
  const message = el<HTMLParagraphElement>("tents-message");
  const level = el<HTMLParagraphElement>("tents-level");
  const newButton = el<HTMLButtonElement>("tents-new-button");

  let board: TentsBoard | null = null;
  let started = false;

  function paint(): void {
    if (!board) return;
    const n = board.size;
    for (let r = -1; r < n; r++) {
      for (let c = -1; c < n; c++) {
        const node = grid.children[(r + 1) * (n + 1) + (c + 1)] as HTMLElement | undefined;
        if (!node) continue;
        if (r === -1 && c === -1) continue;
        if (r === -1) {
          // Countdown of tents still to place; negative means overfilled.
          const left = board.colCounts[c] - tentsInCol(board, c);
          node.textContent = String(left);
          node.classList.toggle("is-ok", left === 0);
          node.classList.toggle("is-over", left < 0);
          continue;
        }
        if (c === -1) {
          const left = board.rowCounts[r] - tentsInRow(board, r);
          node.textContent = String(left);
          node.classList.toggle("is-ok", left === 0);
          node.classList.toggle("is-over", left < 0);
          continue;
        }
        const isTree = board.trees[r][c];
        const mark = board.marks[r][c];
        node.classList.toggle("is-tree", isTree);
        node.classList.toggle("is-tent", !isTree && mark === "tent");
        node.classList.toggle("is-grass", !isTree && mark === "grass");
        node.textContent = isTree ? "🌲" : mark === "tent" ? "⛺" : "";
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

  function setStatus(): void {
    if (!board) return;
    level.textContent = `${tentsPlaced(board)}/${totalTents(board)} tents`;
    message.textContent = board.over && board.won ? "Solved." : "";
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
          frag.appendChild(head);
        } else {
          const cell = document.createElement("button");
          cell.type = "button";
          cell.className = "board-cell tent-cell";
          cell.dataset.row = String(r);
          cell.dataset.col = String(c);
          cell.setAttribute("role", "gridcell");
          frag.appendChild(cell);
        }
      }
    }
    grid.appendChild(frag);
  }

  function newGame(): void {
    board = createBoard(generateLevel());
    started = true;
    buildGrid();
    paint();
    setStatus();
  }

  function activateCell(cell: HTMLElement): void {
    if (!started || !board || board.over) return;
    const r = Number(cell.dataset.row);
    const c = Number(cell.dataset.col);
    if (!Number.isInteger(r) || !Number.isInteger(c)) return;
    if (!toggleMark(board, r, c)) return;
    checkWin(board);
    paint();
    setStatus();
    cell.focus({ preventScroll: true });
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
  newButton.addEventListener("click", newGame);

  return {
    id: "tents",
    mount(): void {
      root.classList.remove("hidden");
      document.getElementById("top")?.classList.add("has-result");
      if (!started) newGame();
      else {
        paint();
        setStatus();
      }
    },
    unmount(): void {
      root.classList.add("hidden");
    },
  };
}
