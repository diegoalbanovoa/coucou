// core/settings-intent.ts: the note the island's "Install hooks" button leaves
// for the Settings window. It must be acted on once, and never throw.

import { test } from "node:test";
import assert from "node:assert/strict";
import { leaveSettingsIntent, takeSettingsIntent } from "../src/core/settings-intent.ts";

function fakeStorage() {
  const data = new Map();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
  };
}

test("the note is read once and then gone", () => {
  Object.defineProperty(globalThis, "localStorage", { value: fakeStorage(), configurable: true });
  assert.equal(takeSettingsIntent(), null);
  leaveSettingsIntent("installHooks");
  assert.equal(takeSettingsIntent(), "installHooks");
  assert.equal(takeSettingsIntent(), null);
});

test("without storage it does nothing and does not throw", () => {
  Object.defineProperty(globalThis, "localStorage", {
    value: { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() {} },
    configurable: true,
  });
  assert.doesNotThrow(() => leaveSettingsIntent("installHooks"));
  assert.equal(takeSettingsIntent(), null);
});
