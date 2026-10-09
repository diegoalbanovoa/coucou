// The gauge's colour threshold (src/ui/gauge.ts) — see docs/plan-v2.md § 6.3.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DISK_THRESHOLDS, LOAD_THRESHOLDS, toneFor } from "../src/ui/gauge.ts";

test("load (CPU/memory) turns orange at 70 and red at 85", () => {
  assert.equal(toneFor(0), "green");
  assert.equal(toneFor(69.9), "green");
  assert.equal(toneFor(70), "orange");
  assert.equal(toneFor(84.9), "orange");
  assert.equal(toneFor(85), "red");
  assert.equal(toneFor(100), "red");
});

test("a drive stays green well past where memory would alarm", () => {
  assert.equal(toneFor(76, DISK_THRESHOLDS), "green", "76% full is ordinary for a disk");
  assert.equal(toneFor(89.9, DISK_THRESHOLDS), "green");
  assert.equal(toneFor(90, DISK_THRESHOLDS), "orange");
  assert.equal(toneFor(95, DISK_THRESHOLDS), "red");
});

test("thresholds default to the load table when none is given", () => {
  assert.equal(toneFor(70), toneFor(70, LOAD_THRESHOLDS));
});
