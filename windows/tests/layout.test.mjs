// Island geometry clamping (src/core/layout.ts) — see docs/plan-v2.md § 4.1.
//
// The real bug this guards against: a view asking for more height than the
// native window (PANEL_H) can draw gets clipped at the OS level, not just
// scrolled — see docs/plan-v2-notas.md § Fase 4 for how that was found.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAT_MAX_H, CHAT_MIN_H, chatPromptHeight, clampViewHeight } from "../src/core/layout.ts";

test("clampViewHeight: inside the range, desired wins untouched", () => {
  assert.equal(clampViewHeight(400, 600, 300), 400);
});

test("clampViewHeight: pinned to the ceiling when desired overshoots", () => {
  assert.equal(clampViewHeight(900, 600, 300), 600);
});

test("clampViewHeight: pinned to the floor when desired undershoots", () => {
  assert.equal(clampViewHeight(100, 600, 300), 300);
});

test("clampViewHeight: a ceiling below the floor still never exceeds it — a tiny display wins over the floor", () => {
  assert.equal(clampViewHeight(400, 250, 300), 250);
});

test("chatPromptHeight: a short conversation never grows past 300 + its own count", () => {
  assert.equal(chatPromptHeight(0, false, 1080), CHAT_MIN_H);
  assert.equal(chatPromptHeight(2, false, 1080), 300 + 2 * 44);
});

test("chatPromptHeight: the ceiling is 62% of the real work area, not the raw display", () => {
  // 1000 * 0.62 = 620, which is already CHAT_MAX_H — the display's work area
  // has to be well over CHAT_MAX_H / 0.62 before the hard cap, not the share,
  // is what is actually binding.
  assert.equal(chatPromptHeight(50, true, 1000), CHAT_MAX_H);
  assert.equal(chatPromptHeight(50, true, 500), 310, "62% of a short work area, floored at nothing lower than itself");
});

test("chatPromptHeight: never past CHAT_MAX_H, however tall the conversation or the display", () => {
  assert.equal(chatPromptHeight(500, false, 4000), CHAT_MAX_H);
  assert.equal(chatPromptHeight(500, true, 4000), CHAT_MAX_H);
});

test("chatPromptHeight: never under CHAT_MIN_H, even on a short display", () => {
  assert.equal(chatPromptHeight(0, false, 200), CHAT_MIN_H);
  assert.equal(chatPromptHeight(0, true, 200), CHAT_MIN_H);
});

test("chatPromptHeight: a populated attachment tray gets its own room, not squeezed out of the log's", () => {
  // Regression: the tray used to be sized for Fase 4's short image chips: once
  // Fase 5 made the tiles 56px, a populated tray clipped against the composer
  // because nothing told islandSize() it needed the extra room — see
  // docs/plan-v2-notas.md § Fase 5.
  const bare = chatPromptHeight(2, false, 1080, false);
  const withTray = chatPromptHeight(2, false, 1080, true);
  assert.ok(withTray > bare, "a populated tray must ask for more height than an empty one");
});

test("chatPromptHeight: the tray's extra room still respects the ceiling", () => {
  assert.equal(chatPromptHeight(500, false, 4000, true), CHAT_MAX_H);
});
