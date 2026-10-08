// The island chat's agent side: which CLI it runs, which folder it runs in,
// and what `/` can reach.
//
// There is deliberately very little here. The turn itself is one Rust call,
// and everything that happens during it — the steps, the diffs, the permission
// card — arrives as ordinary Claude Code hook events, because the session
// Coucou spawns runs the same hooks any terminal session does. See agent.rs.

import { Bridge } from "../core/bridge";
import type { CliInfo, SlashCommand } from "../core/bridge";
import { State } from "../core/state";
import type { Island } from "./island";

/** CLIs found on this machine, loaded once at boot. */
export let availableClis: CliInfo[] = [];

/** `/` targets for the current project. Refreshed whenever one is attached. */
export let slashCommands: SlashCommand[] = [];

/** The island, so the chat can hold it open. Set once, at boot. */
let island: Island | null = null;

export function registerAgentHandlers(host: Island) {
  island = host;
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
  await refreshSlashCommands();
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

/** Cycles to the next installed CLI, or back to the API chat. */
export function nextProvider() {
  if (availableClis.length === 0) return;
  const index = availableClis.findIndex((c) => c.id === State.agentCli);
  // One past the end is the API chat, which is the only mode that works with
  // no CLI installed and the only one that needs a key.
  const next = index + 1;
  State.agentCli = next >= availableClis.length ? null : availableClis[next].id;
  // Remembered, so the next run opens on the agent the user actually uses.
  void Bridge.agentSetCli(State.agentCli);
  State.notify();
}

/** The label shown in the chat header for the current provider. */
export function providerLabel(): string {
  const cli = availableClis.find((c) => c.id === State.agentCli);
  return cli ? cli.label : "Claude API";
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
