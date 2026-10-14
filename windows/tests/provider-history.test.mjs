// The conversation a provider profile receives (src/core/provider-history.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { providerHistory } from "../src/core/provider-history.ts";

const msg = (id, role, content) => ({ id, role, content, at: id });

test("the last message, the prompt being sent, is left out", () => {
  const h = providerHistory([msg(1, "user", "hi"), msg(2, "assistant", "yo"), msg(3, "user", "now")]);
  assert.deepEqual(h, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "yo" },
  ]);
});

test("failed turns are not part of the dialogue", () => {
  const h = providerHistory([msg(1, "user", "a"), msg(2, "error", "boom"), msg(3, "user", "b")]);
  assert.deepEqual(h, [{ role: "user", content: "a" }]);
});

test("a first message has no history", () => {
  assert.deepEqual(providerHistory([msg(1, "user", "first")]), []);
  assert.deepEqual(providerHistory([]), []);
});

test("only role and content travel", () => {
  const h = providerHistory([{ ...msg(1, "assistant", "x"), steps: ["Bash"] }, msg(2, "user", "y")]);
  assert.deepEqual(Object.keys(h[0]).sort(), ["content", "role"]);
});
