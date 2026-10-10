// src/consoles/order.ts — see docs/plan-v2.md § 3.3 and § 3.4.

import { test } from "node:test";
import assert from "node:assert/strict";
import { orderConsoles, pages, selectedConsoleMissing, tileStateFor } from "../src/consoles/order.ts";

const claude = { id: "claude", label: "Claude Code", verified: true };
const gemini = { id: "gemini", label: "Gemini CLI", verified: true };
const copilot = { id: "copilot", label: "Copilot CLI", verified: false };
const codex = { id: "codex", label: "Codex CLI", verified: false };

test("tileStateFor: selected wins over unverified, otherwise normal", () => {
  assert.equal(tileStateFor(claude, "claude"), "selected");
  assert.equal(tileStateFor(copilot, "claude"), "unverified");
  assert.equal(tileStateFor(gemini, "claude"), "normal");
  // Selected beats everything, even an unverified one.
  assert.equal(tileStateFor(copilot, "copilot"), "selected");
});

test("selectedConsoleMissing: only true when the id picked is nowhere in the list", () => {
  const list = [claude, gemini];
  assert.equal(selectedConsoleMissing("claude", list), false);
  assert.equal(selectedConsoleMissing("codex", list), true, "codex was uninstalled since it was picked");
  assert.equal(selectedConsoleMissing(null, list), false, "nothing picked is not the same as picked and gone");
});

test("orderConsoles: selected, then live, then verified, then the rest — alphabetical within each", () => {
  const list = [codex, gemini, claude, copilot];
  const ordered = orderConsoles(list, "codex", new Set(["gemini"]));
  assert.deepEqual(ordered.map((c) => c.id), ["codex", "gemini", "claude", "copilot"]);
});

test("orderConsoles: alphabetical tiebreak within a group", () => {
  const b = { id: "b", label: "Beta", verified: true };
  const a = { id: "a", label: "Alpha", verified: true };
  const ordered = orderConsoles([b, a], null, new Set());
  assert.deepEqual(ordered.map((c) => c.id), ["a", "b"]);
});

test("orderConsoles never mutates its input", () => {
  const list = [gemini, claude];
  const copy = [...list];
  orderConsoles(list, "claude", new Set());
  assert.deepEqual(list, copy);
});

test("pages: splits into groups of n, last one short", () => {
  const items = [1, 2, 3, 4, 5];
  assert.deepEqual(pages(items, 4), [[1, 2, 3, 4], [5]]);
});

test("pages: an empty list is one empty page, not zero pages", () => {
  assert.deepEqual(pages([], 4), [[]]);
});

test("pages: exactly one page when everything fits", () => {
  assert.deepEqual(pages([1, 2], 4), [[1, 2]]);
});
