// Coucou HIG (src/styles/tokens.css, src/ui/) — see docs/plan-v2.md § 1.
//
// Two checks: every `var(--x)` in a stylesheet actually resolves to some
// `--x:` declared somewhere in src/, and the design system's own surface
// (src/styles/, src/ui/) never reaches for a literal hex colour instead of
// a token.
//
// The hex check is scoped to that surface rather than all of src/: the rest
// of the app (core/, island/, views/, mochi/, upload/, settings/) is full of
// pre-existing literal colours — bot outfits, integration brand colours,
// pill badges — and rule 3 of docs/plan-v2.md § 1 only asks that each one
// migrate to tokens "dentro de cada fase que toque ese archivo", not all at
// once in Fase 1. A whole-codebase version of this test would fail on
// day one for files nobody has touched yet, which would make the test noise
// rather than a gate. What Fase 1 can honestly promise is that the thing it
// built — tokens.css and ui/ — does not itself start that pile growing; later
// phases narrow the gap file by file as they migrate the views they redesign.
// ui/tile.ts is the one exception even within that surface: its three
// pill-badge colours are copied verbatim from the buildPill() this phase
// extracted, to keep the extraction pixel-identical (see docs/plan-v2-notas.md).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const UI_SRC = join(SRC, "ui");
const STYLES_SRC = join(SRC, "styles");

function allFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? allFiles(path) : [path];
  });
}

const cssFiles = allFiles(SRC).filter((f) => extname(f) === ".css");

/**
 * Pre-existing gaps this test found but Fase 1 did not create and does not
 * fix — touching them would be scope creep into files this phase otherwise
 * leaves alone (rule 3, docs/plan-v2.md § 1; see docs/plan-v2-notas.md):
 *   --wash         set at runtime via `style.setProperty` (views/chat.ts,
 *                  views/views.ts), never in a stylesheet — legitimate, not a gap.
 *   --ink-1/-3     used in style.css, declared nowhere — looks like a pre-Fase-1
 *                  typo (for --ink/--ink-2?) that quietly no-ops those rules.
 *                  Left for whichever phase actually touches that CSS.
 *   --tile-accent  same pattern as --wash: set at runtime via
 *                  `style.setProperty` (views/consoles.ts, from the
 *                  selected console's own color), with a literal fallback
 *                  in .console-tile-selected's `var(--tile-accent, #22c55e)`
 *                  for the one frame before JS sets it.
 */
const KNOWN_UNDECLARED = new Set(["--wash", "--ink-1", "--ink-3", "--tile-accent"]);

test("every CSS variable used in src/ is declared somewhere in src/", () => {
  const declared = new Set();
  for (const f of cssFiles) {
    for (const [, name] of readFileSync(f, "utf8").matchAll(/(--[a-z0-9-]+)\s*:/g)) declared.add(name);
  }

  const missing = new Set();
  for (const f of cssFiles) {
    for (const [, name] of readFileSync(f, "utf8").matchAll(/var\((--[a-z0-9-]+)/g)) {
      if (!declared.has(name) && !KNOWN_UNDECLARED.has(name)) missing.add(name);
    }
  }
  assert.deepEqual([...missing], [], `referenced but never declared: ${[...missing].join(", ")}`);
});

test("the design system's own surface never reaches for a literal hex colour", () => {
  const designSystemFiles = [...allFiles(UI_SRC), ...allFiles(STYLES_SRC)];
  const offenders = [];
  for (const f of designSystemFiles) {
    const rel = relative(SRC, f).split(sep).join("/");
    if (rel === "styles/tokens.css") continue; // the tokens themselves
    if (rel === "ui/tile.ts") continue; // see the file note above
    const text = readFileSync(f, "utf8");
    for (const match of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) offenders.push(`${rel}: ${match[0]}`);
  }
  assert.deepEqual(offenders, [], `stray hex in the design system itself:\n${offenders.join("\n")}`);
});
