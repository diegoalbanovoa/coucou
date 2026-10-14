// The routine scheduler's pure parts (src/island/routines.ts): when the next
// routine comes due, who is overdue after a sleep, and whether a digest may open.
// All in local time, like the scheduler.

import { test } from "node:test";
import assert from "node:assert/strict";
import { canOpenDigest, dueBetween, LATE_WINDOW_MS, MAX_SLEEP_MS, nextDue, shouldRunLate, sleepFor } from "../src/island/routines.ts";

const routine = (id, time, days, enabled = true) => ({
  id, label: id, prompt: "p", profileId: "x", time, days, tools: false, skill: null, enabled,
});

// 2026-10-14 is a Wednesday (getDay() === 3).
const wed = (h, m = 0) => new Date(2026, 9, 14, h, m, 0, 0);
const day = (offset, h, m = 0) => new Date(2026, 9, 14 + offset, h, m, 0, 0);

test("nextDue: the same day, before the hour, is today", () => {
  const due = nextDue([routine("a", "08:30", [3])], wed(7));
  assert.equal(due.id, "a");
  assert.equal(due.at.getTime(), wed(8, 30).getTime());
});

test("nextDue: the same day, after the hour, waits for the next day that is chosen", () => {
  const due = nextDue([routine("a", "08:30", [3, 5])], wed(9));
  assert.equal(due.at.getTime(), day(2, 8, 30).getTime(), "Friday");
});

test("nextDue: exactly at the hour it is already past (strictly after now)", () => {
  const due = nextDue([routine("a", "08:30", [3])], wed(8, 30));
  assert.equal(due.at.getTime(), day(7, 8, 30).getTime(), "next Wednesday");
});

test("nextDue: a day that is not included is skipped", () => {
  const due = nextDue([routine("a", "08:30", [1])], wed(7));
  assert.equal(due.at.getTime(), day(5, 8, 30).getTime(), "Monday");
});

test("nextDue: it crosses the week and the month", () => {
  const sat = new Date(2026, 9, 31, 23, 0, 0, 0); // Saturday
  const due = nextDue([routine("a", "00:30", [0])], sat);
  assert.equal(due.at.getTime(), new Date(2026, 10, 1, 0, 30).getTime(), "Sunday 1 November");
});

test("nextDue: with several routines the nearest wins", () => {
  const due = nextDue([routine("late", "18:00", [3]), routine("soon", "09:00", [3]), routine("other", "07:00", [4])], wed(8));
  assert.equal(due.id, "soon");
});

test("nextDue: switched-off routines, malformed times and an empty list give nothing", () => {
  assert.equal(nextDue([routine("a", "08:30", [3], false)], wed(7)), null);
  assert.equal(nextDue([routine("a", "8:3", [3])], wed(7)), null);
  assert.equal(nextDue([routine("a", "08:30", [])], wed(7)), null);
  assert.equal(nextDue([], wed(7)), null);
});

test("shouldRunLate: exactly 60 minutes late still runs, one millisecond more does not", () => {
  const due = wed(8);
  assert.equal(shouldRunLate(due, new Date(due.getTime() + LATE_WINDOW_MS)), true);
  assert.equal(shouldRunLate(due, new Date(due.getTime() + LATE_WINDOW_MS + 1)), false);
  assert.equal(shouldRunLate(due, due), true);
});

test("dueBetween: what came due while the machine slept, oldest first", () => {
  const rs = [routine("b", "08:30", [3]), routine("a", "08:00", [3])];
  const got = dueBetween(rs, wed(7), wed(9));
  assert.deepEqual(got.map((d) => d.id), ["a", "b"]);
});

test("dueBetween: the lower bound is exclusive and the upper inclusive", () => {
  const rs = [routine("a", "08:00", [3])];
  assert.equal(dueBetween(rs, wed(8), wed(9)).length, 0);
  assert.equal(dueBetween(rs, wed(7), wed(8)).length, 1);
});

test("dueBetween: a long sleep leaves one entry per routine, its latest hour", () => {
  const rs = [routine("a", "08:00", [0, 1, 2, 3, 4, 5, 6])];
  const got = dueBetween(rs, day(-5, 12), wed(12));
  assert.equal(got.length, 1);
  assert.equal(got[0].at.getTime(), wed(8).getTime());
});

test("dueBetween: ignores switched-off routines and days that are not chosen", () => {
  assert.equal(dueBetween([routine("a", "08:00", [3], false)], wed(7), wed(9)).length, 0);
  assert.equal(dueBetween([routine("a", "08:00", [1])], wed(7), wed(9)).length, 0);
});

test("sleepFor: until the hour, never above 30 minutes or below a second", () => {
  const now = wed(7);
  assert.equal(sleepFor(wed(7, 10), now), 10 * 60_000);
  assert.equal(sleepFor(wed(12), now), MAX_SLEEP_MS);
  assert.equal(sleepFor(new Date(now.getTime() + 5), now), 1_000);
});

test("canOpenDigest: only collapsed, with no approval, no chat turn in flight and not paused", () => {
  const rest = { mode: "hidden", pendingApproval: null, chatSending: false, paused: false };
  assert.equal(canOpenDigest(rest), true);
  assert.equal(canOpenDigest({ ...rest, mode: "compact" }), true);
  assert.equal(canOpenDigest({ ...rest, mode: "expanded" }), false);
  assert.equal(canOpenDigest({ ...rest, pendingApproval: { requestId: "r" } }), false);
  assert.equal(canOpenDigest({ ...rest, chatSending: true }), false);
  assert.equal(canOpenDigest({ ...rest, paused: true }), false);
});
