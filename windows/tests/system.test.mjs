// What the System tab says (src/views/system.ts).
//
// The three pure functions: how a size reads, what the preview line says, and
// what the result line says. The drawing and the polling need a DOM, and the
// deleting is Rust's — guarded and tested there, in system.rs.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  foundLine,
  gaugeAria,
  groupProcesses,
  isAgentProcess,
  overallTone,
  size,
  sweptLine,
  usageRowParts,
} from "../src/views/system.ts";

const found = (over = {}) => ({
  id: "temp",
  label: "Temporary files",
  about: "Your own temp folder.",
  path: "C:/Temp",
  files: 0,
  bytes: 0,
  note: "",
  ...over,
});

const swept = (over = {}) => ({ id: "temp", files: 0, bytes: 0, inUse: 0, ...over });

test("a size reads the way a person would say it", () => {
  assert.equal(size(0), "0 B");
  assert.equal(size(900), "900 B");
  assert.equal(size(1024), "1.0 KB");
  assert.equal(size(1536), "1.5 KB");
  assert.equal(size(5 * 1024 * 1024), "5.0 MB");
  assert.equal(size(1024 ** 3), "1.0 GB");
});

test("one decimal below ten and none above, so both read at a glance", () => {
  assert.equal(size(9.4 * 1024 ** 3), "9.4 GB");
  assert.equal(size(140 * 1024 ** 3), "140 GB");
  assert.equal(size(999 * 1024 ** 2), "999 MB", "no 999.0");
});

test("nothing negative and nothing beyond terabytes", () => {
  assert.equal(size(-1), "0 B");
  assert.equal(size(Number.NaN), "0 B");
  assert.ok(size(1024 ** 6).endsWith(" TB"), "the scale stops at TB rather than inventing one");
});

test("a note is what the preview says, whatever the counts are", () => {
  // "not on this machine" and "Windows did not report it" are more use than
  // a confident zero.
  assert.equal(foundLine(found({ note: "not on this machine" })), "not on this machine");
  assert.equal(
    foundLine(found({ note: "already empty", files: 0 })),
    "already empty",
    "the note wins over the count",
  );
});

test("the preview counts files and bytes, and gets the plural right", () => {
  assert.equal(foundLine(found({ files: 1, bytes: 2048 })), "1 file · 2.0 KB");
  assert.equal(foundLine(found({ files: 412, bytes: 1024 ** 3 })), "412 files · 1.0 GB");
  assert.equal(foundLine(found({ files: 0 })), "nothing to clean");
});

test("the result says what was freed, and what was left alone", () => {
  assert.equal(sweptLine(swept({ files: 3, bytes: 3072 })), "3 removed · 3.0 KB freed");
  assert.equal(
    sweptLine(swept({ files: 3, bytes: 3072, inUse: 2 })),
    "3 removed · 3.0 KB freed · 2 in use, left alone",
    "a file something else had open is reported, not hidden",
  );
});

test("a sweep that removed nothing still says so", () => {
  assert.equal(sweptLine(swept()), "0 removed · 0 B freed");
});

// ── groupProcesses (plan-v2.md § 6.4) ──────────────────────────────────────

const proc = (over = {}) => ({ pid: 1, name: "a.exe", memory: 100, protected: false, startTime: "1", ...over });

test("processes with the same executable name fold into one group", () => {
  const groups = groupProcesses([
    proc({ pid: 1, name: "claude.exe", memory: 100, startTime: "1" }),
    proc({ pid: 2, name: "claude.exe", memory: 200, startTime: "2" }),
    proc({ pid: 3, name: "chrome.exe", memory: 50, startTime: "3" }),
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].name, "claude.exe", "heaviest group first");
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].memory, 300);
  assert.equal(groups[0].members.length, 2);
  assert.equal(groups[1].name, "chrome.exe");
});

test("grouping is case-insensitive, but keeps the casing it first saw", () => {
  const groups = groupProcesses([proc({ name: "Claude.exe" }), proc({ pid: 2, name: "claude.exe" })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "Claude.exe");
  assert.equal(groups[0].count, 2);
});

test("a group is protected the moment any one of its members is", () => {
  const groups = groupProcesses([
    proc({ pid: 1, protected: false }),
    proc({ pid: 2, protected: true }),
  ]);
  assert.ok(groups[0].protected);
});

test("an empty list groups into nothing", () => {
  assert.deepEqual(groupProcesses([]), []);
});

// ── overallTone (plan-v2.md § 6.2's headline) ──────────────────────────────

test("the headline tone is whichever of CPU and memory is worse", () => {
  assert.equal(overallTone(10, 10), "green");
  assert.equal(overallTone(75, 10), "orange", "CPU alone can turn it orange");
  assert.equal(overallTone(10, 75), "orange", "so can memory alone");
  assert.equal(overallTone(90, 10), "red");
  assert.equal(overallTone(10, 90), "red");
});

// ── gaugeAria (plan-v2.md § 6.3: colour is never the only signal) ──────────

test("a normal gauge's aria-label carries no qualifier", () => {
  assert.equal(gaugeAria("green", "CPU", 18, "8 cores"), "CPU 18 percent, 8 cores");
});

test("a high gauge says so in words, not only in colour", () => {
  assert.equal(gaugeAria("orange", "Memory", 76, "11.4 GB of 15 GB"), "Memory 76 percent, high, 11.4 GB of 15 GB");
});

test("a critical gauge says so too", () => {
  assert.equal(gaugeAria("red", "CPU", 91, "8 cores"), "CPU 91 percent, critical, 8 cores");
});

// ── isAgentProcess (plan-v2.md § 6.4's agent warning) ───────────────────────

test("a known agent CLI is recognised with or without the .exe", () => {
  assert.ok(isAgentProcess("claude.exe"));
  assert.ok(isAgentProcess("CLAUDE.EXE"));
  assert.ok(isAgentProcess("cursor-agent"));
});

test("an ordinary process is not mistaken for an agent", () => {
  assert.ok(!isAgentProcess("chrome.exe"));
  assert.ok(!isAgentProcess("claude-but-not-really.exe"));
});

// ── usageRowParts (plan v4, Fase 4) ─────────────────────────────────────────

const usage = (over = {}) => ({
  backend: "cli:claude",
  label: "Claude Code",
  turns: 12,
  errors: 0,
  p50FirstTextMs: 2300,
  p50TotalMs: 14800,
  inputTokens: 184200,
  outputTokens: 9120,
  costUsd: 1.37,
  ...over,
});

test("a row with everything reported shows turns, timings, tokens and cost", () => {
  const parts = usageRowParts(usage(), "en-US");
  assert.equal(parts.title, "Claude Code");
  assert.equal(parts.subtitle, "12 turns · first text 2.3 s · total 14.8 s");
  assert.equal(parts.tokens, "184,200 in · 9,120 out");
  assert.equal(parts.cost, "$1.37");
});

test("what the source never reported is left out, not shown as zero", () => {
  const parts = usageRowParts(usage({ turns: 1, p50FirstTextMs: null, p50TotalMs: 420, inputTokens: null, outputTokens: null, costUsd: null }), "en-US");
  assert.equal(parts.subtitle, "1 turn · total 420 ms");
  assert.equal(parts.tokens, null);
  assert.equal(parts.cost, null);
});

test("a single reported token count is shown on its own", () => {
  assert.equal(usageRowParts(usage({ outputTokens: null }), "en-US").tokens, "184,200 in");
  assert.equal(usageRowParts(usage({ inputTokens: null }), "en-US").tokens, "9,120 out");
});

test("a tiny cost keeps its precision and the currency follows the locale", () => {
  assert.equal(usageRowParts(usage({ costUsd: 0.0004 }), "en-US").cost, "$0.0004");
  assert.match(usageRowParts(usage({ costUsd: 1.37 }), "es-ES").cost, /1,37/);
});

test("durations use the locale's decimal separator", () => {
  assert.match(usageRowParts(usage(), "es-ES").subtitle, /first text 2,3 s/);
});
