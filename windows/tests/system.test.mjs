// What the System tab says (src/views/system.ts).
//
// The three pure functions: how a size reads, what the preview line says, and
// what the result line says. The drawing and the polling need a DOM, and the
// deleting is Rust's — guarded and tested there, in system.rs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { foundLine, size, sweptLine } from "../src/views/system.ts";

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
