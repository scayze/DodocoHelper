import type { GameInstance } from "../types.js";
import { formatClock, todayUTC } from "../../leaderboard/api.js";
import { announceWin, bindTimerPill, createRunTimer } from "../../leaderboard/report.js";
import { BOARD_EVENT, type BoardDetail } from "../../leaderboard/view.js";
import { fetchDailySeeds, mulberry32 } from "../daily.js";
import {
  clampMinesSettings,
  isEndlessUnlocked,
  loadEndlessSettings,
  saveEndlessSettings,
  setEndlessUnlocked,
  type MinesEndlessSettings,
  type PlayMode,
} from "../mode.js";
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
import type { Opening } from "./solver.js";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

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
  const level = el("mines-level");
  const timerValue = el("mines-timer-value");
  const modeDailyBtn = el<HTMLButtonElement>("mines-mode-daily");
  const modeEndlessBtn = el<HTMLButtonElement>("mines-mode-endless");
  const modeSep = el("mines-mode-sep");
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
  let winReported = false;

  /** Session-only mode; every load boots into daily. */
  let mode: PlayMode = "daily";
  const endlessTimer = createRunTimer();
  let settingsOpen = false;
  /** Stashed per-mode play state; working vars above always mirror the active mode. */
  interface Slot {
    board: MineBoard;
    rand: () => number;
    opening: Opening | null;
    started: boolean;
    winReported: boolean;
    day: string | null;
    timerLive: boolean;
  }
  let daily: Slot | null = null;
  let endless: Slot | null = null;

  function activeTimer(): ReturnType<typeof createRunTimer> {
    return mode === "endless" ? endlessTimer : runTimer;
  }

  function stashActive(): void {
    if (!started) return;
    const slot: Slot = {
      board,
      rand: boardRand,
      opening: openingHint,
      started,
      winReported,
      day: dailyDay,
      timerLive: true,
    };
    if (mode === "daily") daily = slot;
    else endless = slot;
  }
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
          mode === "daily" &&
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
    activeTimer().stop();
    timerValue.textContent = formatClock(activeTimer().elapsed());
  }

  function pauseClock(): void {
    runTimer.pause();
    endlessTimer.pause();
  }

  function resumeClock(): void {
    if (started && !board.over) activeTimer().resume();
  }

  function onBoardToggle(e: Event): void {
    const detail = (e as CustomEvent<BoardDetail>).detail;
    if (!detail || detail.game !== "minesweeper") return;
    if (detail.showingBoard) pauseClock();
    else resumeClock();
  }

  function setStatus(): void {
    const left = Math.max(0, board.mineCount - flaggedCount());
    level.textContent = left === 1 ? "1 mine" : `${left} mines`;
    if (board.over && board.won) {
      message.textContent = "Solved.";
      freezeClock();
      if (!winReported) {
        winReported = true;
        // Endless wins stay local: only daily wins reach the leaderboard.
        if (mode === "daily") {
          // Solving the daily reveals the endless button (rest of the day).
          setEndlessUnlocked(todayUTC());
          announceWin({ game: "minesweeper", durationMs: runTimer.elapsed(), moves: board.revealedCount });
          paintMode();
        }
      }
    } else if (board.over) {
      message.textContent = "Boom — that one had a mine.";
      freezeClock();
    } else {
      message.textContent = "";
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
    if (mode !== "daily") {
      // Parked while endless is showing; timer starts on return to daily.
      daily = { board: fresh, rand, opening, started: true, winReported: false, day, timerLive: false };
      return;
    }
    board = fresh;
    boardRand = rand;
    openingHint = opening;
    dailyDay = day;
    started = true;
    winReported = false;
    daily = { board, rand: boardRand, opening, started, winReported, day, timerLive: true };
    runTimer.start();
    if (typeof document !== "undefined" && document.hidden) runTimer.pause();
    bindTimerPill(runTimer, "mines-timer-value", formatClock);
    clearPress();
    buildGrid();
    paint();
    setStatus();
  }

  function ensureDaily(): void {
    const day = todayUTC();
    if (daily && daily.started && daily.day === day) return;
    void fetchDailySeeds(day).then(({ day: seedDay, seeds }) => {
      if (daily && daily.started && daily.day === seedDay) return;
      dealDaily(seedDay, seeds.minesweeper);
    });
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

  /** Deal a fresh endless board (pre-generated, guaranteed-solvable). */
  function dealEndless(): void {
    const s = readSettings();
    const { mines, opening } = generateMines(s.size, s.mines, Math.random);
    board = createPreplacedBoard(s.size, s.mines, mines);
    boardRand = Math.random;
    openingHint = opening;
    dailyDay = null;
    started = true;
    winReported = false;
    endless = { board, rand: boardRand, opening, started, winReported, day: null, timerLive: true };
    endlessTimer.start();
    if (typeof document !== "undefined" && document.hidden) endlessTimer.pause();
    bindTimerPill(endlessTimer, "mines-timer-value", formatClock);
    clearPress();
    buildGrid();
    paint();
    setStatus();
  }

  /** Show the stored slot's board; start or resume its timer as appropriate. */
  function activateSlot(slot: Slot): void {
    board = slot.board;
    boardRand = slot.rand;
    openingHint = slot.opening;
    dailyDay = slot.day;
    started = slot.started;
    winReported = slot.winReported;
    const timer = activeTimer();
    bindTimerPill(timer, "mines-timer-value", formatClock);
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
  }

  function paintSettings(): void {
    const show = mode === "endless" && settingsOpen;
    settingsPanel.classList.toggle("hidden", !show);
    settingsPanel.classList.toggle("flex", show);
    settingsToggle.setAttribute("aria-expanded", show ? "true" : "false");
  }

  function paintMode(): void {
    const isEndless = mode === "endless";
    modeDailyBtn.classList.toggle("is-active", !isEndless);
    modeDailyBtn.setAttribute("aria-pressed", String(!isEndless));
    modeEndlessBtn.classList.toggle("is-active", isEndless);
    modeEndlessBtn.setAttribute("aria-pressed", String(isEndless));
    // Endless spawns in (with a pop) once today's daily is completed.
    const unlocked = isEndlessUnlocked(todayUTC());
    const wasLocked = modeEndlessBtn.classList.contains("hidden");
    modeEndlessBtn.classList.toggle("hidden", !unlocked);
    modeSep.classList.toggle("hidden", !unlocked);
    if (unlocked && wasLocked) {
      for (const node of [modeEndlessBtn, modeSep]) {
        node.classList.remove("unlock-pop");
        void node.offsetWidth;
        node.classList.add("unlock-pop");
        node.addEventListener("animationend", () => node.classList.remove("unlock-pop"), {
          once: true,
        });
      }
    }
    settingsToggle.classList.toggle("hidden", !isEndless);
    regenBtn.classList.toggle("hidden", !isEndless);
    // The leaderboard only tracks daily scores.
    viewToggle.classList.toggle("hidden", isEndless);
    if (isEndless && !lbView.classList.contains("hidden")) viewToggle.click();
    paintSettings();
  }

  function setMode(next: PlayMode): void {
    if (mode === next) return;
    if (next === "endless" && !isEndlessUnlocked(todayUTC())) return;
    stashActive();
    activeTimer().pause();
    mode = next;
    settingsOpen = false;
    const slot = mode === "daily" ? daily : endless;
    if (slot && slot.started) {
      activateSlot(slot);
    } else if (mode === "endless") {
      dealEndless();
    } else {
      started = false;
      buildGrid();
      paint();
      setStatus();
      ensureDaily();
    }
    paintMode();
  }

  function cellCoords(cell: HTMLElement): [number, number] | null {
    const r = Number(cell.dataset.row);
    const c = Number(cell.dataset.col);
    if (!Number.isInteger(r) || !Number.isInteger(c)) return null;
    return [r, c];
  }

  function flagCell(cell: HTMLElement): void {
    if (!started || board.over) return;
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
  }

  /** True when this cell was (un)flagged a moment ago by the other press path. */
  function recentlyFlagged(r: number, c: number): boolean {
    return recentFlagKey === `${r},${c}` && performance.now() - recentFlagAt < 700;
  }

  function activateCell(cell: HTMLElement): void {
    if (!started || board.over) return;
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
      return;
    }
    paint();
    setStatus();
    cell.focus({ preventScroll: true });
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
    const coords = cellCoords(cell);
    if (!coords) return;
    const hitMine = chord(board, coords[0], coords[1], boardRand);
    if (hitMine) revealAllMines();
    paint();
    setStatus();
    cell.focus({ preventScroll: true });
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
  window.addEventListener(BOARD_EVENT, onBoardToggle);
  modeDailyBtn.addEventListener("click", () => setMode("daily"));
  modeEndlessBtn.addEventListener("click", () => setMode("endless"));
  regenBtn.addEventListener("click", () => {
    if (mode === "endless") dealEndless();
  });
  settingsToggle.addEventListener("click", () => {
    settingsOpen = !settingsOpen;
    paintSettings();
  });
  setSizeInput.addEventListener("change", readSettings);
  setMinesInput.addEventListener("change", readSettings);
  fillSettingsInputs(loadEndlessSettings("minesweeper"));

  return {
    id: "minesweeper",
    mount(): void {
      root.classList.remove("hidden");
      document.getElementById("top")?.classList.add("has-result");
      if (mode === "endless") {
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
        ensureDaily();
      } else if (daily.day !== todayUTC()) {
        ensureDaily();
      } else {
        paint();
        setStatus();
        resumeClock();
      }
      paintMode();
    },
    unmount(): void {
      pauseClock();
      root.classList.add("hidden");
    },
    pauseClock,
    resumeClock,
  };
}
