// src/island/subagentActivity.ts — the bounded, per-agent activity history
// fed from the live "hook" event, independent of handleHook's pill routing.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { SubagentActivity, recordSubagentActivity } from "../src/island/subagentActivity.ts";

beforeEach(() => {
  // No public reset — each test uses its own agent name so entries from an
  // earlier test never leak into an assertion.
});

test("an event with no agent_type is ignored", () => {
  recordSubagentActivity({ hook_event_name: "PreToolUse", tool_name: "Bash" });
  assert.deepEqual(SubagentActivity.entriesFor("main"), []);
  assert.equal(SubagentActivity.agents.includes("main"), false);
});

test("an event with agent_type adds an entry for that agent", () => {
  recordSubagentActivity({ hook_event_name: "PreToolUse", tool_name: "Bash", agent_type: "agentA" });
  const entries = SubagentActivity.entriesFor("agentA");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, "Bash");
});

test("SubagentStop records last_assistant_message as the result", () => {
  recordSubagentActivity({
    hook_event_name: "SubagentStop",
    agent_type: "agentB",
    last_assistant_message: "listo",
  });
  const entries = SubagentActivity.entriesFor("agentB");
  assert.equal(entries.at(-1).result, "listo");
});

test("a tool event with no last_assistant_message has no result", () => {
  recordSubagentActivity({ hook_event_name: "PostToolUse", tool_name: "Read", agent_type: "agentC" });
  assert.equal(SubagentActivity.entriesFor("agentC").at(-1).result, undefined);
});

test("falls back to hook_event_name when tool_name is absent", () => {
  recordSubagentActivity({ hook_event_name: "Stop", agent_type: "agentD" });
  assert.equal(SubagentActivity.entriesFor("agentD").at(-1).action, "Stop");
});

test("each agent gets its own entry list", () => {
  recordSubagentActivity({ hook_event_name: "PreToolUse", tool_name: "Bash", agent_type: "agentE1" });
  recordSubagentActivity({ hook_event_name: "PreToolUse", tool_name: "Edit", agent_type: "agentE2" });
  assert.equal(SubagentActivity.entriesFor("agentE1").length, 1);
  assert.equal(SubagentActivity.entriesFor("agentE2").length, 1);
  assert.equal(SubagentActivity.entriesFor("agentE1")[0].action, "Bash");
  assert.equal(SubagentActivity.entriesFor("agentE2")[0].action, "Edit");
});

test("a very active agent is capped at 20 entries, oldest evicted first (FIFO)", () => {
  for (let i = 0; i < 25; i++) {
    recordSubagentActivity({ hook_event_name: "PreToolUse", tool_name: `tool${i}`, agent_type: "agentF" });
  }
  const entries = SubagentActivity.entriesFor("agentF");
  assert.equal(entries.length, 20);
  // The first 5 (tool0..tool4) were evicted; the oldest surviving is tool5.
  assert.equal(entries[0].action, "tool5");
  assert.equal(entries.at(-1).action, "tool24");
});

test("subscribe() is notified on every recorded entry", () => {
  let notifications = 0;
  const unsubscribe = SubagentActivity.subscribe(() => notifications++);
  recordSubagentActivity({ hook_event_name: "PreToolUse", tool_name: "Bash", agent_type: "agentG" });
  recordSubagentActivity({ hook_event_name: "PreToolUse", tool_name: "Bash", agent_type: "agentG" });
  assert.equal(notifications, 2);
  unsubscribe();
  recordSubagentActivity({ hook_event_name: "PreToolUse", tool_name: "Bash", agent_type: "agentG" });
  assert.equal(notifications, 2);
});
