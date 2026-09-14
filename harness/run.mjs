// End-to-end persistence harness: plays one move per game in daily AND
// endless mode, "reloads" (fresh module eval + fresh DOM, same localStorage),
// and checks the stored board survives untouched (i.e. was restored, not
// redealt). Run via `npm run test:e2e`.
import "./stubs.mjs";
import { freshStorage, resetDom, __store } from "./stubs.mjs";

const tick = (n = 3) =>
  new Promise((r) => setTimeout(r, 0)).then(async () => {
    if (n > 1) await tick(n - 1);
  });

let flag = 0;
async function load(path) {
  return import(`./out/games/${path}?v=${++flag}`);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function clickCell(grid, r, c) {
  const cell = document.createElement("button");
  cell.dataset.row = String(r);
  cell.dataset.col = String(c);
  grid.fire("click", cell);
}

const MODE_BUTTONS = {
  crowns: "crowns-mode-endless",
  minesweeper: "mines-mode-endless",
  seasons: "seasons-mode-endless",
  tents: "tents-mode-endless",
};

/** Play one move, reload, remount, and assert the board key is untouched. */
async function scenario(id, factory, click, mode) {
  freshStorage();
  if (mode === "endless") {
    localStorage.setItem(`dodoco:endless-unlocked:${id}`, today());
  }
  const modA = await load(`${id}/controller.js`);
  const gameA = modA[factory]();
  gameA.mount();
  await tick();
  if (mode === "endless") {
    document.getElementById(MODE_BUTTONS[id]).fire("click");
    await tick();
  }
  if (click) click();
  await tick();
  const key = `dodoco:board:${id}:${mode}`;
  const first = __store().get(key);
  if (first === undefined) {
    console.log(`${id}/${mode.padEnd(7)} FAIL: nothing saved on first play (${key})`);
    return false;
  }

  // Simulate a reload: fresh DOM + fresh module state, same localStorage.
  resetDom();
  const modB = await load(`${id}/controller.js`);
  const gameB = modB[factory]();
  gameB.mount();
  await tick();
  if (mode === "endless") {
    document.getElementById(MODE_BUTTONS[id]).fire("click");
    await tick();
  }
  const second = __store().get(key);

  let result;
  if (second === undefined) {
    result = "FAIL: storage cleared by reload (restore rejected the board)";
  } else if (first !== second) {
    result = `FAIL: board was redealt after reload (${first.length}B -> ${second.length}B)`;
  } else {
    result = "PASS: board restored untouched (" + first.length + " bytes)";
  }
  console.log(`${id.padEnd(11)} ${mode.padEnd(7)} ${result}`);
  return second !== undefined && first === second;
}

const dailyClicks = {
  crowns: () => {
    const grid = document.getElementById("board-grid");
    clickCell(grid, 0, 0);
    clickCell(grid, 1, 1);
  },
  minesweeper: () => {
    const grid = document.getElementById("mines-grid");
    clickCell(grid, 0, 0);
    clickCell(grid, 0, 1);
  },
  seasons: () => {
    const grid = document.getElementById("seasons-grid");
    clickCell(grid, 0, 0);
  },
  tents: () => {
    const grid = document.getElementById("tents-grid");
    clickCell(grid, 0, 0);
    clickCell(grid, 0, 1);
  },
};

const games = [
  ["crowns", "createCrownsGame"],
  ["minesweeper", "createMinesweeperGame"],
  ["seasons", "createSeasonsGame"],
  ["tents", "createTentsGame"],
];

const results = [];
for (const [id, factory] of games) {
  for (const mode of ["daily", "endless"]) {
    try {
      results.push(await scenario(id, factory, dailyClicks[id], mode));
    } catch (e) {
      console.log(`${id}/${mode.padEnd(7)} ERROR: ${e}`);
      results.push(false);
    }
  }
}
console.log(results.every(Boolean) ? "\nALL SCENARIOS PASS" : "\nSOME SCENARIO(S) FAILED");
process.exit(results.every(Boolean) ? 0 : 1);