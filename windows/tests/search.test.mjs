// Finding things in the conversation (src/views/search.ts).
//
// Only the model side is tested: `highlight` needs a DOM, and a DOM in these
// tests would mean a dependency the repo does without. Everything the find bar
// decides — what counts as a hit, what the counter says, where the arrows go —
// is here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_QUERY, counter, findMatches, step } from "../src/views/search.ts";

const msg = (id, content) => ({ id, role: "assistant", content, at: id });

const log = [
  msg(1, "the pipe gave up for good"),
  msg(2, "no — the PIPE retries once a second now, and the pipe before it did not"),
  msg(3, "nothing to do with it"),
];

test("hits come back in reading order, oldest message first", () => {
  const found = findMatches(log, "pipe");

  // Asserted as the property rather than as counted offsets: hand-counting
  // positions in a string with an em dash in it is how the first version of
  // this test came to claim the code was wrong when it was not.
  assert.deepEqual(found.map((m) => m.id), [1, 2, 2], "by message, oldest first");
  const inTwo = found.filter((m) => m.id === 2).map((m) => m.at);
  assert.ok(inTwo[0] < inTwo[1], "and left to right within one message");

  // Every offset really points at the needle.
  for (const m of found) {
    const content = log.find((x) => x.id === m.id).content;
    assert.equal(content.slice(m.at, m.at + m.length).toLowerCase(), "pipe");
  }
});

test("case is not something a transcript search should care about", () => {
  assert.equal(findMatches(log, "PIPE").length, 3);
  assert.equal(findMatches(log, "pipe").length, 3);
  assert.equal(findMatches(log, "PiPe").length, 3);
});

test("every hit carries the length that was searched for", () => {
  for (const m of findMatches(log, "retries")) assert.equal(m.length, 7);
});

test("a query too short to mean anything finds nothing", () => {
  assert.equal(MIN_QUERY, 2);
  assert.deepEqual(findMatches(log, ""), []);
  assert.deepEqual(findMatches(log, " "), []);
  assert.deepEqual(findMatches(log, "p"), [], "one letter matches half the log");
  assert.equal(findMatches(log, "pi").length, 3, "two is enough");
});

test("surrounding spaces are not part of the query", () => {
  assert.equal(findMatches(log, "  pipe  ").length, 3);
});

test("overlapping text is not counted twice", () => {
  // "aaaa" holds two "aa" hits, not three: each one starts after the last.
  assert.equal(findMatches([msg(1, "aaaa")], "aa").length, 2);
});

test("the counter is one-based, and says so plainly when there is nothing", () => {
  const found = findMatches(log, "pipe");
  assert.equal(counter(found, 0), "1/3");
  assert.equal(counter(found, 2), "3/3");
  assert.equal(counter([], 0), "none", "never 0/0");
});

test("the arrows wrap at both ends, so neither ever needs disabling", () => {
  const found = findMatches(log, "pipe");
  assert.equal(step(found, 0, 1), 1);
  assert.equal(step(found, 2, 1), 0, "past the last comes the first");
  assert.equal(step(found, 0, -1), 2, "before the first comes the last");
  assert.equal(step([], 0, 1), 0, "and nothing to step through is not an error");
});
