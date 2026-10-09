// src/i18n/ — see docs/plan-v2.md § 2.5.

import { test } from "node:test";
import assert from "node:assert/strict";
import { en } from "../src/i18n/en.ts";
import { es } from "../src/i18n/es.ts";
import { fmtBytes, fmtPercent, tn } from "../src/i18n/index.ts";

/** Every dot path to a leaf string, `{one,other}` plural leaves included as
 *  one path each (not split into .one/.other) — what a key "exists" means
 *  for this file's purposes. */
function leafPaths(node, prefix = "") {
  const out = [];
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      out.push(path);
    } else if (value && typeof value === "object" && "one" in value && "other" in value) {
      out.push(path);
    } else {
      out.push(...leafPaths(value, path));
    }
  }
  return out;
}

function get(node, path) {
  return path.split(".").reduce((n, part) => n?.[part], node);
}

test("es has exactly the keys of en", () => {
  const enPaths = new Set(leafPaths(en));
  const esPaths = new Set(leafPaths(es));
  const missingInEs = [...enPaths].filter((p) => !esPaths.has(p));
  const extraInEs = [...esPaths].filter((p) => !enPaths.has(p));
  assert.deepEqual(missingInEs, [], `es is missing: ${missingInEs.join(", ")}`);
  assert.deepEqual(extraInEs, [], `es has keys en does not: ${extraInEs.join(", ")}`);
});

test("no string is empty in either locale", () => {
  for (const [name, dict] of [["en", en], ["es", es]]) {
    for (const path of leafPaths(dict)) {
      const value = get(dict, path);
      if (typeof value === "string") {
        assert.ok(value.length > 0, `${name}.${path} is empty`);
      } else {
        assert.ok(value.one.length > 0, `${name}.${path}.one is empty`);
        assert.ok(value.other.length > 0, `${name}.${path}.other is empty`);
      }
    }
  }
});

test("every {placeholder} in en has the same set in es", () => {
  const placeholders = (s) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
  const mismatches = [];
  for (const path of leafPaths(en)) {
    const a = get(en, path);
    const b = get(es, path);
    const pairs = typeof a === "string" ? [[a, b]] : [[a.one, b.one], [a.other, b.other]];
    for (const [enStr, esStr] of pairs) {
      const enSet = placeholders(enStr);
      const esSet = placeholders(esStr);
      const same = enSet.size === esSet.size && [...enSet].every((p) => esSet.has(p));
      if (!same) mismatches.push(`${path}: en {${[...enSet]}} vs es {${[...esSet]}}`);
    }
  }
  assert.deepEqual(mismatches, [], mismatches.join("\n"));
});

test("fmtBytes writes the locale's own decimal mark", () => {
  const value = 9.8 * 1024 ** 3;
  assert.equal(fmtBytes(value, "en"), "9.8 GB");
  assert.equal(fmtBytes(value, "es"), "9,8 GB");
});

test("fmtBytes keeps whole numbers whole, and never goes negative", () => {
  assert.equal(fmtBytes(0, "en"), "0 B");
  assert.equal(fmtBytes(-5, "en"), "0 B");
  assert.equal(fmtBytes(140 * 1024 ** 3, "en"), "140 GB");
});

test("fmtPercent reads the same shape in both locales", () => {
  assert.equal(fmtPercent(76, "en"), "76%");
  assert.match(fmtPercent(76, "es"), /76\s?%/);
});

test("tn() picks the plural category Intl.PluralRules selects", () => {
  assert.equal(tn("consoles.count", 1), "1 console");
  assert.equal(tn("consoles.count", 3), "3 consoles");
});
