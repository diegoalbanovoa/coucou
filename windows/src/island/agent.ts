// The island chat's agent side: which CLI it runs, which folder it runs in,
// and what `/` can reach.
//
// There is deliberately very little here. The turn itself is one Rust call,
// and everything that happens during it — the steps, the diffs, the permission
// card — arrives as ordinary Claude Code hook events, because the session
// Coucou spawns runs the same hooks any terminal session does. See agent.rs.

import { Bridge, onEvent } from "../core/bridge";
import type { Console, KeptMessage, SlashCommand } from "../core/bridge";
import { State } from "../core/state";
import type { Island } from "./island";

/** CLIs found on this machine, loaded once at boot. */
export let availableClis: Console[] = [];

/** `/` targets for the current project. Refreshed whenever one is attached. */
export let slashCommands: SlashCommand[] = [];

/** The island, so the chat can hold it open. Set once, at boot. */
let island: Island | null = null;

export function registerAgentHandlers(host: Island) {
  island = host;

  // The versions are not known when the list first arrives — asking a CLI
  // costs a process start — so Rust sends the finished list on afterwards.
  void onEvent<Console[]>("agent-clis", (clis) => {
    availableClis = clis;
    State.notify();
  });

  // A turn sent with nothing attached runs in the default folder from
  // settings, and Rust attaches it. The chip has to say so, or the chat would
  // be running somewhere the island never mentioned.
  void onEvent<string>("agent-folder", (project) => {
    State.attachedProject = project;
    void refreshSlashCommands().then(() => State.notify());
  });
}

export async function loadAgentEnvironment() {
  availableClis = (await Bridge.agentClis()) ?? [];
  // Rust restored the project it was in when it last ran, so the chat opens on
  // that conversation instead of on an empty box with nothing attached.
  const remembered = await Bridge.agentState();
  State.attachedProject = remembered?.project ?? null;

  // The remembered CLI only counts if it is still installed — one can be
  // uninstalled between two runs.
  const stillInstalled = availableClis.some((c) => c.id === remembered?.cli);
  if (stillInstalled) {
    State.agentCli = remembered!.cli;
  } else if (!State.agentCli && availableClis.length > 0) {
    // A CLI is the better default when there is one: it needs no API key and
    // brings the user's own tools, skills and CLAUDE.md with it.
    State.agentCli = availableClis[0].id;
    void Bridge.agentSetCli(State.agentCli);
  }
  await restoreConversation();
  await refreshSlashCommands();
  State.notify();
}

/**
 * Puts back the conversation the last run ended on.
 *
 * Rust has already resumed its CLI session, so without this the island would
 * come back continuing a conversation it was showing none of.
 */
async function restoreConversation() {
  if (State.chatHistory.length > 0) return;
  const kept = (await Bridge.chatLoad()) ?? [];
  State.chatHistory = kept.map((message, index) => ({ id: index + 1, ...message }));
}

/** Keeps the conversation for the next run. Called when a turn settles. */
export function keepConversation() {
  const kept: KeptMessage[] = State.chatHistory.map((message) => ({
    role: message.role,
    content: message.content,
    at: message.at,
    steps: message.steps ?? [],
  }));
  void Bridge.chatKeep(kept);
}

/**
 * Starts a new conversation: the island's log, the CLI session and what is
 * kept on disk all go together. Anything that drops one has to drop all three,
 * or the island shows one conversation while the CLI resumes another.
 */
export function startFreshConversation() {
  State.chatHistory = [];
  State.chatDraft = "";
  State.chatSteps = [];
  void Bridge.chatForget();
  State.notify();
}

/**
 * Looks for consoles again.
 *
 * The same command the boot path calls: it re-reads PATH and the install
 * folders on every call by design, so installing a CLI shows up without a
 * restart. Versions still arrive afterwards on `agent-clis`.
 */
export async function reloadConsoles() {
  const found = (await Bridge.agentClis()) ?? [];
  availableClis = found;
  // A CLI that was uninstalled must not stay the chat's choice.
  if (State.agentCli && !found.some((c) => c.id === State.agentCli)) {
    chooseProvider(found.length > 0 ? found[0].id : null);
    return;
  }
  State.notify();
}

export async function refreshSlashCommands() {
  slashCommands = (await Bridge.agentCommands()) ?? [];
}

/** Attach / detach, from the chip in the chat header. */
export async function toggleProject() {
  if (State.attachedProject) {
    await Bridge.detachProject();
    State.attachedProject = null;
    await refreshSlashCommands();
    State.notify();
    return;
  }
  // The folder picker is a native window, so the cursor has to leave the
  // island to use it — and a cursor that leaves auto-closes the island after
  // `autoCloseInterval`, which is shorter than most folder hunts. Pinning is
  // what the approval card already does for the same shape of wait: something
  // the user must come back to the island to finish.
  State.isPinned = true;
  island?.pin();
  try {
    const picked = await Bridge.pickProject();
    if (!picked) return; // cancelled, or a picker was already open
    try {
      State.attachedProject = await Bridge.attachProject(picked);
    } catch (err) {
      void Bridge.log(`attach failed: ${String(err)}`);
      State.attachedProject = null;
    }
    await refreshSlashCommands();
  } finally {
    State.isPinned = false;
    island?.dropPin();
    State.notify();
  }
}

/** Picks the agent the chat runs, and remembers the choice. */
export function chooseProvider(id: string | null) {
  State.agentCli = id;
  void Bridge.agentSetCli(id);
  State.notify();
}

/**
 * Cycles through the installed CLIs.
 *
 * There is no API-key mode at the end of the list any more. A CLI brings the
 * user's own subscription, tools, skills and CLAUDE.md; the key brought a
 * worse agent and a secret to look after.
 */
export function nextProvider() {
  if (availableClis.length < 2) return;
  const index = availableClis.findIndex((c) => c.id === State.agentCli);
  chooseProvider(availableClis[(index + 1) % availableClis.length].id);
}

/** The label shown in the chat header for the current agent. */
export function providerLabel(): string {
  const cli = availableClis.find((c) => c.id === State.agentCli);
  if (cli) return cli.label;
  return availableClis.length === 0 ? "No agent CLI found" : "Pick an agent";
}

/**
 * What `/` offers for what has been typed so far. Only ever consulted while
 * the input starts with a slash, so an ordinary question never pays for it.
 */
export function matchingCommands(typed: string): SlashCommand[] {
  if (!typed.startsWith("/")) return [];
  const term = typed.slice(1).toLowerCase();
  const matches = slashCommands.filter((c) => c.name.toLowerCase().includes(term));
  // A long list in a 320 pt island is a scroll nobody wants; the closest
  // matches are what the user is reaching for anyway.
  matches.sort((a, b) => {
    const aStarts = a.name.toLowerCase().startsWith(term) ? 0 : 1;
    const bStarts = b.name.toLowerCase().startsWith(term) ? 0 : 1;
    return aStarts - bStarts || a.name.localeCompare(b.name);
  });
  return matches.slice(0, 6);
}
