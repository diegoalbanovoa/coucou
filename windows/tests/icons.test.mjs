// The icon set (src/views/icons.ts).
//
// Only the definitions are checked, not the drawing: `icon()` needs a DOM, and
// a DOM in these tests would mean a dependency the repo does without. What
// matters here is the contract every icon has to keep — one grid, no colour of
// its own — because that contract is what lets a button's state be CSS.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ICONS, STROKE } from "../src/views/icons.ts";

const names = Object.keys(ICONS);

test("the set covers what the interface actually reaches for", () => {
  const needed = [
    // chrome and navigation
    "house", "bubble", "plus", "gear", "speakerOn", "speakerOff", "search", "folder", "image",
    // actions
    "arrowUp", "arrowDown", "check", "xmark", "copy", "stop", "refresh", "broom",
    // status and system
    "bang", "timer", "cpu", "memory", "disk",
  ];
  const missing = needed.filter((n) => !(n in ICONS));
  assert.deepEqual(missing, [], "missing icons");
});

test("every icon carries at least one path and nothing empty", () => {
  for (const name of names) {
    const def = ICONS[name];
    assert.ok(Array.isArray(def.d), `${name}: d must be an array`);
    assert.ok(def.d.length > 0, `${name}: no paths`);
    for (const d of def.d) {
      assert.equal(typeof d, "string", `${name}: a path must be a string`);
      assert.ok(d.trim().length > 0, `${name}: an empty path`);
      assert.match(d.trim(), /^[Mm]/, `${name}: a path must start with a move`);
    }
  }
});

test("no icon carries a colour of its own", () => {
  // A literal colour anywhere in a definition would survive into the DOM and
  // beat the button's `currentColor`, which is the whole encoding.
  const colour = /#[0-9a-f]{3,8}|rgb|hsl|\bfill\b|\bstroke\b/i;
  for (const name of names) {
    for (const d of ICONS[name].d) {
      assert.doesNotMatch(d, colour, `${name}: a colour or paint attribute in its path data`);
    }
  }
});

test("every number in an icon belongs to a 24×24 grid", () => {
  // Magnitude only. A negative number is usually a legitimate relative move —
  // `v-5.2` goes up 5.2 from where the pen is — and telling those apart from
  // absolute coordinates would mean parsing the path grammar, which is not
  // what this test is for. What it does catch is the real failure mode: path
  // data lifted from a 48×48 or 512×512 icon, which shows up immediately as
  // numbers far outside the box.
  for (const name of names) {
    for (const d of ICONS[name].d) {
      // `.35` is a number in SVG, and a pattern that needs a digit before the
      // point reads it as 35 — which looked like an icon drawn on a 48-unit
      // grid and was nothing of the kind.
      for (const [raw] of d.matchAll(/-?(?:\d*\.\d+|\d+\.?)/g)) {
        const n = Number(raw);
        assert.ok(Math.abs(n) <= 26, `${name}: ${n} does not belong to a 24-unit grid`);
      }
    }
  }
});

test("the stroke weight is one number, shared", () => {
  assert.equal(typeof STROKE, "number");
  assert.ok(STROKE > 1 && STROKE < 3, "a hairline or a slab would both be wrong here");
});

test("only the icons a stroke cannot say are solid", () => {
  const solid = names.filter((n) => ICONS[n].solid);
  assert.deepEqual(solid.sort(), ["gear", "speakerOff", "speakerOn", "stop"]);
});
