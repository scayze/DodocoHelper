/**
 * Build the E2E harness artifacts: a copy of src (minus shell files) compiled
 * with the harness tsconfig so controller wiring can run under Node with DOM
 * stubs (see harness/run.mjs). Run via `npm run test:e2e`.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const harness = join(root, "harness");
const srcDir = join(harness, "src");
const outDir = join(harness, "out");

// 1. Copy src (controllers included) into the harness tree.
rmSync(srcDir, { recursive: true, force: true });
rmSync(outDir, { recursive: true, force: true });
mkdirSync(srcDir, { recursive: true });
cpSync(join(root, "src"), srcDir, { recursive: true });

// 2. Shell files never compile here; the CSS import is a vite-only concern.
rmSync(join(srcDir, "main.ts"), { force: true });
rmSync(join(srcDir, "games", "registry.ts"), { force: true });
const crownsPath = join(srcDir, "games", "crowns", "controller.ts");
writeFileSync(
  crownsPath,
  readFileSync(crownsPath, "utf8").replace(/^import "\.\.\/\.\.\/index\.css";\n/m, ""),
);

// 3. Compile through the harness tsconfig.
const tscBin = join(root, "node_modules", ".bin", "tsc");
const { status, stderr } = spawnSync(tscBin, ["-p", join(harness, "tsconfig.json")], {
  cwd: root,
});
const errText = new TextDecoder().decode(stderr ?? new Uint8Array());
if (errText.trim().length > 0) process.stderr.write(errText);
if (status !== 0) throw new Error(`tsc exited with status ${status}`);

// 4. `import.meta.env` is a vite transform; patch it out of the compiled JS.
const patchDir = join(outDir, "games", "crowns");
const viewJs = join(patchDir, "view.js");
writeFileSync(viewJs, readFileSync(viewJs, "utf8").replaceAll("import.meta.env.BASE_URL", '""'));

console.log("harness built");