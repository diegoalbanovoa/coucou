// Mochi's health moods (src/mochi/moods.ts) — plan-v2.md § 7.4's acceptance:
// lerpMood at its extremes and midpoint, and the blink/sweat/cough calendar
// with a fixed seed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { lerpMood, MOODS, mulberry32, MoodScheduler } from "../src/mochi/moods.ts";

test("lerpMood at t=0 is exactly the first mood", () => {
  const got = lerpMood(MOODS.ok, MOODS.sick, 0);
  assert.equal(got.tintAmount, MOODS.ok.tintAmount);
  assert.equal(got.eyeLid, MOODS.ok.eyeLid);
  assert.equal(got.tint, MOODS.ok.tint);
  assert.equal(got.thermometer, MOODS.ok.thermometer);
});

test("lerpMood at t=1 is exactly the second mood", () => {
  const got = lerpMood(MOODS.ok, MOODS.sick, 1);
  assert.equal(got.tintAmount, MOODS.sick.tintAmount);
  assert.equal(got.eyeLid, MOODS.sick.eyeLid);
  assert.equal(got.tint, MOODS.sick.tint);
  assert.equal(got.thermometer, MOODS.sick.thermometer);
});

test("lerpMood at the midpoint sits between the two numbers", () => {
  const got = lerpMood(MOODS.ok, MOODS.sick, 0.5);
  assert.ok(got.tintAmount > MOODS.ok.tintAmount && got.tintAmount < MOODS.sick.tintAmount);
  assert.ok(got.blush > MOODS.ok.blush && got.blush < MOODS.sick.blush);
  assert.equal(got.tintAmount, (MOODS.ok.tintAmount + MOODS.sick.tintAmount) / 2);
});

test("a discrete property (eye style, thermometer) switches at the midpoint, not before", () => {
  assert.equal(lerpMood(MOODS.ok, MOODS.sick, 0.49).thermometer, MOODS.ok.thermometer);
  assert.equal(lerpMood(MOODS.ok, MOODS.sick, 0.5).thermometer, MOODS.sick.thermometer);
  assert.equal(lerpMood(MOODS.ok, MOODS.sick, 0.99).eyeStyle, MOODS.sick.eyeStyle);
});

test("lerpMood clamps t outside 0..1 rather than overshooting", () => {
  assert.equal(lerpMood(MOODS.ok, MOODS.sick, -5).tintAmount, MOODS.ok.tintAmount);
  assert.equal(lerpMood(MOODS.ok, MOODS.sick, 5).tintAmount, MOODS.sick.tintAmount);
});

test("mulberry32 is deterministic: the same seed is the same sequence", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  for (const n of seqA) assert.ok(n >= 0 && n < 1);
});

test("a different seed gives a different sequence", () => {
  const a = mulberry32(1)();
  const b = mulberry32(2)();
  assert.notEqual(a, b);
});

test("the scheduler's blink calendar is reproducible for a fixed seed", () => {
  const first = new MoodScheduler(7);
  first.reset(MOODS.ok, 0);
  const firstHits = [];
  for (let t = 0; t <= 10000; t += 100) {
    if (first.tick(MOODS.ok, t).blink) firstHits.push(t);
  }

  const second = new MoodScheduler(7);
  second.reset(MOODS.ok, 0);
  const secondHits = [];
  for (let t = 0; t <= 10000; t += 100) {
    if (second.tick(MOODS.ok, t).blink) secondHits.push(t);
  }

  assert.deepEqual(firstHits, secondHits);
  assert.ok(firstHits.length > 0, "ok's 3-6s blink range fires at least once in 10s");
});

test("sweat and cough never fire for a mood that carries no schedule for them", () => {
  const s = new MoodScheduler(3);
  s.reset(MOODS.ok, 0);
  for (let t = 0; t <= 20000; t += 50) {
    const tick = s.tick(MOODS.ok, t);
    assert.equal(tick.sweat, false, "ok has no sweatEveryMs");
    assert.equal(tick.cough, false, "ok has no coughEveryMs");
  }
});

test("sick's schedule produces at least one sweat drop and stays within its own ranges", () => {
  const s = new MoodScheduler(11);
  s.reset(MOODS.sick, 0);
  let sweatHits = 0;
  for (let t = 0; t <= 15000; t += 50) {
    if (s.tick(MOODS.sick, t).sweat) sweatHits += 1;
  }
  // sweatEveryMs is a fixed 2500 for sick (not a range), so 15s covers 5-6 drops.
  assert.ok(sweatHits >= 5 && sweatHits <= 7, `expected ~5-6 drops in 15s, got ${sweatHits}`);
});

test("resetting the scheduler on a mood change does not carry over the old countdown", () => {
  const s = new MoodScheduler(5);
  s.reset(MOODS.sick, 0);
  // Jump straight to just before sick's first cough would fire, then switch
  // moods — ok has no cough at all, so none should ever come due.
  s.reset(MOODS.ok, 11000);
  let coughHits = 0;
  for (let t = 11000; t <= 30000; t += 100) {
    if (s.tick(MOODS.ok, t).cough) coughHits += 1;
  }
  assert.equal(coughHits, 0);
});
