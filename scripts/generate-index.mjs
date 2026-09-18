#!/usr/bin/env node
// Render the per-game panels in index.html from one template.
// The template carries __GAME_ID__ / __GAME_LABEL__ tokens (never a real
// game name), so adding a game can't corrupt unrelated words.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const TEMPLATE = path.join(HERE, "index.template.html");
const PANEL_TEMPLATE = path.join(HERE, "game-panel.template.html");
const OUTPUT = path.join(ROOT, "index.html");
const MARKER = "        <!-- GENERATED_GAME_PANELS -->";

const games = [
  {
    id: "mines",
    label: "Minesweeper",
    settings: `
                  <label class="settings-row" for="mines-set-size">
                    <span>Board size</span>
                    <input id="mines-set-size" type="number" min="6" max="12" step="1" inputmode="numeric" />
                  </label>
                  <label class="settings-row" for="mines-set-mines">
                    <span>Bombs</span>
                    <input id="mines-set-mines" type="number" min="1" max="60" step="1" inputmode="numeric" />
                  </label>`,
  },
  {
    id: "seasons",
    label: "Seasons",
    settings: `
                  <label class="settings-row" for="seasons-set-size">
                    <span>Board size</span>
                    <input id="seasons-set-size" type="number" min="6" max="12" step="1" inputmode="numeric" />
                  </label>`,
  },
  {
    id: "snapshot",
    label: "Snapshot",
    settings: `
                  <p class="text-center text-[15px] font-semibold leading-relaxed text-night-800/70">Each board is a new photo. No settings.</p>`,
  },
  {
    id: "tents",
    label: "Tents &amp; Trees",
    settings: `
                  <label class="settings-row" for="tents-set-size">
                    <span>Board size</span>
                    <input id="tents-set-size" type="number" min="5" max="10" step="1" inputmode="numeric" />
                  </label>
                  <label class="settings-row" for="tents-set-trees">
                    <span>Trees</span>
                    <input id="tents-set-trees" type="number" min="2" max="23" step="1" inputmode="numeric" />
                  </label>`,
    undo: true,
  },
];

const settingsHeader = `
                  <div class="flex items-center gap-[9px]">
                    <span class="h-[36px] w-[36px] shrink-0" aria-hidden="true"></span>
                    <div class="min-w-0 flex-1 text-center">
                      <h2 class="text-[15px] font-bold uppercase tracking-[0.18em] text-gold-600">Settings</h2>
                    </div>
                    <span class="h-[36px] w-[36px] shrink-0" aria-hidden="true"></span>
                  </div>`;

const undoButton = (id) => `
                  <button id="${id}-undo-button" type="button" class="btn-outline game-btn h-[48px] w-[48px] rounded-full disabled:cursor-not-allowed disabled:opacity-50" aria-label="Undo" title="Undo" disabled>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M3 7v6h6" />
                      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
                    </svg>
                  </button>`;

function renderPanel(game) {
  const raw = fs.readFileSync(PANEL_TEMPLATE, "utf8");
  if (!raw.includes("__GAME_ID__")) throw new Error(`Template missing __GAME_ID__ token`);
  let panel = raw
    .replaceAll("__GAME_ID__", game.id)
    .replaceAll("__GAME_LABEL__", game.label);

  const settingsOpen = `                  <div id="${game.id}-settings"`;
  const settingsStart = panel.indexOf(settingsOpen);
  // Anchor on the settings close + stage close pair: the header row inside
  // ends with an 18-space </div> too, so a single-close search would stop early.
  const settingsEnd = panel.indexOf("\n                  </div>\n                </div>", settingsStart);
  if (settingsStart < 0 || settingsEnd < 0) {
    throw new Error(`Could not locate settings panel for ${game.id}`);
  }
  panel = `${panel.slice(0, settingsStart)}${settingsOpen} class="settings-overlay hidden flex-col gap-[9px] rounded-xl bg-white/70 px-[18px] py-[13px] shadow-sm">${settingsHeader}${game.settings}\n                  </div>${panel.slice(settingsEnd + "\n                  </div>".length)}`;

  if (game.undo) {
    const settingsToggle = panel.indexOf(`                  <button id="${game.id}-settings-toggle"`);
    if (settingsToggle < 0) throw new Error(`Could not locate action row for ${game.id}`);
    panel = `${panel.slice(0, settingsToggle)}${undoButton(game.id)}\n${panel.slice(settingsToggle)}`;
  }
  return panel;
}

function render() {
  const template = fs.readFileSync(TEMPLATE, "utf8");
  if (!template.includes(MARKER)) throw new Error(`Missing ${MARKER} in ${TEMPLATE}`);
  return template.replace(MARKER, games.map(renderPanel).join("\n"));
}

const generated = render();
if (process.argv.includes("--check")) {
  const current = fs.readFileSync(OUTPUT, "utf8");
  if (current !== generated) {
    console.error("index.html is stale; run npm run generate:index");
    process.exitCode = 1;
  } else {
    console.log("index.html is up to date");
  }
} else {
  fs.writeFileSync(OUTPUT, generated);
  console.log(`generated ${path.relative(ROOT, OUTPUT)}`);
}
