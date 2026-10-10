// The tooltip Mochi carries while not `ok` (src/island/health.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { healthTooltip } from "../src/island/health.ts";
import { setLocale } from "../src/i18n/index.ts";

const event = (over = {}) => ({ level: "strained", cause: "memory", cpu: 32, memory: 76, disk: 20, ...over });

test("the tooltip names the level and the cause, with the cause's own value", () => {
  setLocale("en");
  assert.equal(healthTooltip(event()), "Feeling a little dizzy — memory at 76%");
});

test("sick reads differently from strained", () => {
  setLocale("en");
  const text = healthTooltip(event({ level: "sick", cause: "cpu", cpu: 91 }));
  assert.match(text, /Not feeling well/);
  assert.match(text, /CPU at 91%/);
});

test("the cause picks its own field's value, not another one's", () => {
  setLocale("en");
  const text = healthTooltip(event({ cause: "disk", disk: 95, cpu: 10, memory: 10 }));
  assert.match(text, /disk at 95%/);
});

test("reads in Spanish once the locale is set", () => {
  setLocale("es");
  const text = healthTooltip(event({ level: "sick", cause: "memory", memory: 88 }));
  // Intl's own percent formatter may or may not put a space before "%" in
  // es depending on the ICU data available — see i18n.test.mjs's own
  // fmtPercent test, which allows the same thing.
  assert.match(text, /^No se siente bien — memoria al 88\s?%$/);
  setLocale("en");
});
