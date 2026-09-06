import type { PuzzleInput } from "../core/types.js";
import { loadOpenCV } from "./opencv.js";


export interface ExtractResult {
  ok: boolean;
  error: string | null;
}



function notImplemented(): ExtractResult {
  return {
    ok: false,
    error: "puzzle extraction is not implemented yet",
  };
}

export async function extractBoardFromFile(_file: File): Promise<ExtractResult> {
  return notImplemented();
}


/** Ensure the OpenCV runtime is initialised. Safe to call multiple times. */
export async function ensureOpenCV(): Promise<void> {
  await loadOpenCV();
}