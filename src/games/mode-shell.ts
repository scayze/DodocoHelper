import { formatClock, todayUTC } from "../leaderboard/api.js";
import { createRunTimer, bindTimerPill as bindPill } from "../leaderboard/report.js";
import { fetchDailySeeds } from "./daily.js";
import { isEndlessUnlocked, type PlayMode } from "./mode.js";
import type { GameId } from "./types.js";

export interface ModeShellElements {
  modeDaily: HTMLButtonElement;
  modeEndless: HTMLButtonElement;
  modeSeparator: HTMLElement;
  settings: HTMLElement;
  settingsToggle: HTMLButtonElement;
  regenerate: HTMLButtonElement;
  viewToggle: HTMLButtonElement;
  leaderboardView: HTMLElement;
  timerValue: string;
}

export interface ModeShellConfig<TSlot> {
  id: GameId;
  elements: ModeShellElements;
  dailyTimer: ReturnType<typeof createRunTimer>;
  endlessTimer: ReturnType<typeof createRunTimer>;

  getSlot(mode: PlayMode): TSlot | null;
  setSlot(mode: PlayMode, slot: TSlot): void;
  snapshot(): TSlot | null;
  restoreSlot(slot: TSlot): void;
  dealDaily(day: string, seed: number): void;
  dealEndless(): void;
  onEmptyDaily(): void;
  hasDaily(day: string): boolean;
  canResume(): boolean;
}

export interface ModeShell {
  readonly id: GameId;
  readonly mode: PlayMode;
  readonly dailyTimer: ReturnType<typeof createRunTimer>;
  readonly endlessTimer: ReturnType<typeof createRunTimer>;
  activeTimer(): ReturnType<typeof createRunTimer>;
  modeTag(): string;
  bindTimerPill(): void;
  ensureDaily(): void;
  stashActive(): void;
  setMode(next: PlayMode): void;
  paintMode(): void;
  paintSettings(): void;
  pauseClock(): void;
  resumeClock(): void;
  attachListeners(): void;
}

/**
 * Shared daily/endless lifecycle for every game. Board state remains opaque to
 * this module: games provide slot/deal/restore callbacks while this owns the
 * mode state, timers, unlock UI, and transition rules.
 */
export function createModeShell<TSlot>(config: ModeShellConfig<TSlot>): ModeShell {
  const { elements } = config;
  let mode: PlayMode = "daily";
  let settingsOpen = false;
  let boardOpenBeforeEndless = false;
  let listenersAttached = false;

  function activeTimer(): ReturnType<typeof createRunTimer> {
    return mode === "endless" ? config.endlessTimer : config.dailyTimer;
  }

  function modeTag(): string {
    return mode === "endless" ? "Endless" : "Daily";
  }

  function bindTimerPill(): void {
    bindPill(activeTimer(), elements.timerValue, formatClock);
  }

  function paintSettings(): void {
    const show = mode === "endless" && settingsOpen;
    elements.settings.classList.toggle("hidden", !show);
    elements.settings.classList.toggle("flex", show);
    elements.settingsToggle.setAttribute("aria-expanded", show ? "true" : "false");
  }

  function paintMode(): void {
    const isEndless = mode === "endless";
    elements.modeDaily.classList.toggle("is-active", !isEndless);
    elements.modeDaily.setAttribute("aria-pressed", String(!isEndless));
    elements.modeEndless.classList.toggle("is-active", isEndless);
    elements.modeEndless.setAttribute("aria-pressed", String(isEndless));

    const unlocked = isEndlessUnlocked(todayUTC());
    const wasLocked = elements.modeEndless.classList.contains("hidden");
    elements.modeEndless.classList.toggle("hidden", !unlocked);
    elements.modeSeparator.classList.toggle("hidden", !unlocked);
    if (unlocked && wasLocked) {
      for (const node of [elements.modeEndless, elements.modeSeparator]) {
        node.classList.remove("unlock-pop");
        void node.offsetWidth;
        node.classList.add("unlock-pop");
        node.addEventListener("animationend", () => node.classList.remove("unlock-pop"), {
          once: true,
        });
      }
    }

    elements.settingsToggle.classList.toggle("hidden", !isEndless);
    elements.regenerate.classList.toggle("hidden", !isEndless);
    elements.viewToggle.classList.toggle("hidden", isEndless);
    if (isEndless && !elements.leaderboardView.classList.contains("hidden")) {
      elements.viewToggle.click();
    }
    paintSettings();
  }

  function ensureDaily(): void {
    const day = todayUTC();
    if (config.hasDaily(day)) return;
    void fetchDailySeeds(day).then(({ day: seedDay, seeds }) => {
      if (config.hasDaily(seedDay)) return;
      config.dealDaily(seedDay, seeds[config.id]);
    });
  }

  function stashActive(): void {
    const slot = config.snapshot();
    if (slot) config.setSlot(mode, slot);
  }

  function setMode(next: PlayMode): void {
    if (mode === next) return;
    if (next === "endless" && !isEndlessUnlocked(todayUTC())) return;
    if (next === "endless") {
      boardOpenBeforeEndless = !elements.leaderboardView.classList.contains("hidden");
    }

    stashActive();
    activeTimer().pause();
    mode = next;
    settingsOpen = false;

    const slot = config.getSlot(mode);
    if (slot) {
      config.restoreSlot(slot);
    } else if (mode === "endless") {
      config.dealEndless();
    } else {
      config.onEmptyDaily();
    }

    paintMode();
    if (next === "daily") {
      if (boardOpenBeforeEndless && elements.leaderboardView.classList.contains("hidden")) {
        elements.viewToggle.click();
      }
      boardOpenBeforeEndless = false;
    }
  }

  function pauseClock(): void {
    config.dailyTimer.pause();
    config.endlessTimer.pause();
  }

  function resumeClock(): void {
    if (config.canResume()) activeTimer().resume();
  }

  function attachListeners(): void {
    if (listenersAttached) return;
    listenersAttached = true;
    elements.modeDaily.addEventListener("click", () => setMode("daily"));
    elements.modeEndless.addEventListener("click", () => setMode("endless"));
    elements.regenerate.addEventListener("click", () => {
      if (mode === "endless") config.dealEndless();
    });
    elements.settingsToggle.addEventListener("click", () => {
      settingsOpen = !settingsOpen;
      paintSettings();
    });
  }

  return {
    id: config.id,
    get mode() {
      return mode;
    },
    dailyTimer: config.dailyTimer,
    endlessTimer: config.endlessTimer,
    activeTimer,
    modeTag,
    bindTimerPill,
    ensureDaily,
    stashActive,
    setMode,
    paintMode,
    paintSettings,
    pauseClock,
    resumeClock,
    attachListeners,
  };
}
