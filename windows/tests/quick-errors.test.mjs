// errorText (src/views/quick.ts): the "<kind>:<detail>" strings Rust sends,
// as the text the user reads. Loop-guard stops must be translated, never shown raw.

import { test } from "node:test";
import assert from "node:assert/strict";
import { errorText } from "../src/views/quick.ts";
import { t } from "../src/i18n/index.ts";

test("a loop-guard stop for repeated actions reads as the loop message", () => {
  assert.equal(errorText("loop-guard:identical"), t("quick.errLoopGuard"));
  assert.equal(errorText("loop-guard:cycle"), t("quick.errLoopGuard"));
});

test("running out of rounds reads as the too-many-steps message", () => {
  assert.equal(errorText("loop-guard:max-rounds"), t("quick.errTooManyRounds"));
});

test("the existing kinds still translate", () => {
  assert.equal(errorText("no-model:x"), t("quick.noModel"));
});
