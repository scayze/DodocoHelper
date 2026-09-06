#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { validatePuzzleInput } from "./validator.js";
import { renderBoard } from "./render.js";

function usage(): string {
  return [
    "Usage: dodoco-render <puzzle.json> [--result solution.json] [--out solved.png]",
    "                     [--cell 64] [--gap 6]",
    "",
    "Renders the board (regions + crowns) as a PNG. --result is the solver CLI",
    "output (contains .solution); omit it to render the empty board.",
  ].join("\n");
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log(usage());
    return args.length === 0 ? 2 : 0;
  }
  let puzzlePath = "";
  let resultPath = "";
  let out = "";
  let cell = 64;
  let gap = 6;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "--result" || a === "-r") && i + 1 < args.length) resultPath = args[++i];
    else if ((a === "--out" || a === "-o") && i + 1 < args.length) out = args[++i];
    else if (a === "--cell" && i + 1 < args.length) cell = Math.max(16, parseInt(args[++i], 10) || 64);
    else if (a === "--gap" && i + 1 < args.length) gap = Math.max(0, parseInt(args[++i], 10) || 0);
    else if (!a.startsWith("-") && !puzzlePath) puzzlePath = a;
    else {
      console.error(`Unknown argument: ${a}\n${usage()}`);
      return 2;
    }
  }
  if (!puzzlePath) {
    console.error(usage());
    return 2;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(puzzlePath, "utf8"));
  } catch (e) {
    console.error(`Cannot read/parse ${puzzlePath}: ${(e as Error).message}`);
    return 2;
  }
  const { errors, puzzle } = validatePuzzleInput(raw);
  if (!puzzle) {
    console.error(`Invalid puzzle: ${errors.join("; ")}`);
    return 2;
  }
  let solution: string[][] | null = null;
  if (resultPath) {
    try {
      const res = JSON.parse(readFileSync(resultPath, "utf8")) as {
        status: string;
        solution: string[][] | null;
      };
      if (res.status !== "solved" || !res.solution) {
        console.error(`Result file has no solution (status: ${res.status})`);
        return 2;
      }
      solution = res.solution;
    } catch (e) {
      console.error(`Cannot read/parse ${resultPath}: ${(e as Error).message}`);
      return 2;
    }
  }
  const png = renderBoard(puzzle, solution, { cell, gap });
  if (out) writeFileSync(out, png);
  else process.stdout.write(png);
  if (out) console.log(`wrote ${out}`);
  return 0;
}

process.exit(main());
