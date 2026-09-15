#!/usr/bin/env node
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

const undoButton = (id) => `
                  <button id="${id}-undo-button" type="button" class="btn-outline game-btn h-[48px] w-[48px] rounded-full disabled:cursor-not-allowed disabled:opacity-50" aria-label="Undo" title="Undo" disabled>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M3 7v6h6" />
                      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
                    </svg>
                  </button>`;

function renderPanel(game) {
  let panel = fs.readFileSync(PANEL_TEMPLATE, "utf8")
    .replaceAll("seasons", game.id)
    .replaceAll("Seasons", game.label);

  const settingsStart = panel.indexOf(`                <div id="${game.id}-settings"`);
  const settingsEnd = panel.indexOf("\n                </div>", settingsStart);
  if (settingsStart < 0 || settingsEnd < 0) {
    throw new Error(`Could not locate settings panel for ${game.id}`);
  }
  panel = `${panel.slice(0, settingsStart)}                <div id="${game.id}-settings" class="hidden flex-col gap-[9px] rounded-xl bg-white/70 px-[18px] py-[13px] shadow-sm">${game.settings}\n                </div>${panel.slice(settingsEnd + "\n                </div>".length)}`;

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
