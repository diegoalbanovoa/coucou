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
