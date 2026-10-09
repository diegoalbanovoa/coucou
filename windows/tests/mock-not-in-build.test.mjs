// `src/dev/mock-bridge.ts` must never reach a production build (see
// plan-v2.md § 0.2): it is pulled in only by the `resolve.alias` Vite applies
// under `--mode mock` (see vite.config.ts), and `npm run build` never passes
// that flag. This runs the real build and checks the real output, rather than
// only inspecting the config, because a config that *looks* right is not the
// same claim as a `dist/` that *is* right.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");

function allFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? allFiles(path) : [path];
  });
}

test("the package.json build script never asks for mock mode", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.doesNotMatch(pkg.scripts.build, /--mode[= ]mock/, "build must not pass --mode mock");
});

test("a real build carries no trace of the mock bridge", { timeout: 60_000 }, () => {
  rmSync(DIST, { recursive: true, force: true });
  // Windows resolves `npx` to `npx.cmd`, which needs a shell to run; the args
  // here are fixed literals, never user input, so the usual risk `shell:
  // true` warns about (unescaped arguments) does not apply.
  const run = (args) => execFileSync("npx", args, { cwd: ROOT, stdio: "pipe", shell: true, windowsHide: true });
  // The same two commands `npm run build` runs, skipping its `prebuild` hook:
  // that rebuilds the unrelated coucou-hook Rust crate, which this test does
  // not need and should not have to wait on.
  run(["tsc", "--noEmit"]);
  run(["vite", "build"]);

  const files = allFiles(DIST).filter((f) => f.endsWith(".js") || f.endsWith(".css"));
  assert.ok(files.length > 0, "the build produced no JS/CSS to check");

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(
      text,
      /mock-bridge|\[mock\]/,
      `${file.slice(ROOT.length)} contains a trace of the mock bridge`,
    );
  }
});
