#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { solvePuzzle } from "./solver.js";

function usage(): string {
  return [
    "Usage: dodoco-solve <puzzle.json> [--out solution.json] [--limit N]",
    "",
    "Reads a puzzle JSON file, solves it, prints the result JSON to stdout",
    "or writes it to --out. Exit code: 0 solved, 1 unsolvable, 2 invalid.",
  ].join("\n");
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log(usage());
    return args.length === 0 ? 2 : 0;
  }
  let input = "";
  let out = "";
  let limit = 1;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--out" || args[i] === "-o") && i + 1 < args.length) out = args[++i];
    else if (args[i] === "--limit" && i + 1 < args.length) limit = Math.max(1, parseInt(args[++i], 10) || 1);
    else if (!args[i].startsWith("-") && !input) input = args[i];
    else {
      console.error(`Unknown argument: ${args[i]}\n${usage()}`);
      return 2;
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(input, "utf8"));
  } catch (e) {
    console.error(`Cannot read/parse ${input}: ${(e as Error).message}`);
    return 2;
  }
  const result = solvePuzzle(raw, { limit });
  const text = JSON.stringify(result, null, 2) + "\n";
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
  return result.status === "solved" ? 0 : result.status === "unsolvable" ? 1 : 2;
}

process.exit(main());
