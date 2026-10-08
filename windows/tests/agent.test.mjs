// The chat's agent side (src/island/agent.ts): what the chat comes up in after
// a restart, and what it hands back to Rust to remember.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { calls, replies, sent } from "./tauri.mjs";
import { loadAgentEnvironment, nextProvider } from "../src/island/agent.ts";
import { State } from "../src/core/state.ts";

const CLAUDE =
  { id: "claude", label: "Claude Code", path: "C:/bin/claude.exe", version: "2.0.1", streams: true };
const GEMINI =
  { id: "gemini", label: "Gemini CLI", path: "C:/bin/gemini.cmd", version: "0.4.2", streams: false };

/** What Rust answers: the CLIs it found, and the state it restored. */
function machine({ clis = [CLAUDE, GEMINI], project = null, cli = null } = {}) {
  replies.set("agent_clis", clis);
  replies.set("agent_state", { project, cli, resuming: false });
}

beforeEach(() => {
  calls.length = 0;
  replies.clear();
  State.agentCli = null;
  State.attachedProject = null;
});

test("the chat comes up in the project and CLI the last run was in", async () => {
  machine({ project: "C:\\code\\thing", cli: "gemini" });

  await loadAgentEnvironment();

  assert.equal(State.attachedProject, "C:\\code\\thing");
  assert.equal(State.agentCli, "gemini");
  // Nothing to write back: this is what Rust just told us.
  assert.deepEqual(sent("agent_set_cli"), []);
});

test("a remembered CLI that is no longer installed falls back to one that is", async () => {
  machine({ clis: [CLAUDE], cli: "gemini" });

  await loadAgentEnvironment();

  assert.equal(State.agentCli, "claude");
  assert.deepEqual(sent("agent_set_cli"), [{ cli: "claude" }]);
});

test("with nothing remembered the first installed CLI is chosen and kept", async () => {
  machine();

  await loadAgentEnvironment();

  assert.equal(State.agentCli, "claude");
  assert.deepEqual(sent("agent_set_cli"), [{ cli: "claude" }]);
});

test("no CLI installed leaves the chat on the API, with nothing remembered", async () => {
  machine({ clis: [] });

  await loadAgentEnvironment();

  assert.equal(State.agentCli, null);
  assert.deepEqual(sent("agent_set_cli"), []);
});

test("switching agent cycles the installed CLIs and remembers the choice", async () => {
  machine({ cli: "claude" });
  await loadAgentEnvironment();
  calls.length = 0;

  nextProvider();
  assert.equal(State.agentCli, "gemini");

  // Past the last one it comes back round. There is no API-key mode at the end
  // of the list to fall into any more.
  nextProvider();
  assert.equal(State.agentCli, "claude");

  assert.deepEqual(sent("agent_set_cli"), [{ cli: "gemini" }, { cli: "claude" }]);
});

test("one installed CLI has nothing to switch to", async () => {
  machine({ clis: [CLAUDE], cli: "claude" });
  await loadAgentEnvironment();
  calls.length = 0;

  nextProvider();

  assert.equal(State.agentCli, "claude");
  assert.deepEqual(sent("agent_set_cli"), []);
});

test("the project Rust restored is what `/` is asked about", async () => {
  machine({ project: "C:\\code\\thing", cli: "claude" });

  await loadAgentEnvironment();

  // The commands are read after the project is known, or they would be the
  // user's own only — the project's `.claude/commands` would be missed.
  const order = calls.map(([name]) => name);
  assert.ok(
    order.indexOf("agent_state") < order.indexOf("agent_commands"),
    `agent_state must come first, got ${order.join(", ")}`,
  );
});
