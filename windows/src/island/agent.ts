/**
 * The island chat's agent side: which CLI it runs, which folder it runs in,
 * and what `/` can reach.
 *
 * There is deliberately very little here. The turn itself is one Rust call,
 * and everything that happens during it — the steps, the diffs, the permission
 * card — arrives as ordinary Claude Code hook events, because the session
 * Coucou spawns runs the same hooks any terminal session does. See agent.rs.
 * Used by views/chat.ts and views/consoles.ts; module-level lets hold the
 * lists they render.
 */

import { Bridge, onEvent } from "../core/bridge";
import type { Console, KeptMessage, OllamaModel, OpenJarvisInfo, ProviderProfile, SlashCommand } from "../core/bridge";
import { State } from "../core/state";
import type { Island } from "./island";
import { t } from "../i18n/index";

/** CLIs found on this machine, loaded once at boot. */
export let availableClis: Console[] = [];

/** Saved chat-only provider profiles — openspec/changes/provider-chat-profiles.
 *  Refreshed by `reloadProviders`, called whenever the chat's provider
 *  picker opens (never polled — picking is rare, and Ollama's own probe is
 *  explicitly on-demand, see design.md decision 6). */
export let availableProviders: ProviderProfile[] = [];
/** Models a local Ollama server reports right now, or empty if none
 *  answers — absence, not a failure. Refreshed alongside `availableProviders`. */
export let ollamaModels: OllamaModel[] = [];
/** The local OpenJarvis server, or null when it is not running. */
export let openjarvis: OpenJarvisInfo | null = null;

/** `/` targets for the current project. Refreshed whenever one is attached. */
export let slashCommands: SlashCommand[] = [];

/** The island, so the chat can hold it open. Set once, at boot. */
let island: Island | null = null;

/** Keeps a reference to the island and subscribes to the "agent-clis" and "agent-folder" events. */
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

/**
 * Boot-time load: installed CLIs, the remembered project and CLI (dropped if
 * that CLI is gone; otherwise the first installed one is the default), the
 * saved conversation and the `/` commands.
 */
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
    attachments: message.attachments ?? [],
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

/** Re-reads the `/` commands for the current project. Callers `notify()` afterwards. */
export async function refreshSlashCommands() {
  slashCommands = (await Bridge.agentCommands()) ?? [];
}

/** Detaches the project, from "Quitar" in the chat header's project menu. */
export async function detachProject() {
  await Bridge.detachProject();
  State.attachedProject = null;
  await refreshSlashCommands();
  State.notify();
}

/**
 * Opens the native folder picker and attaches whatever was chosen — the
 * chip's own click when nothing is attached yet, and "Cambiar…" in its menu
 * when something already is (replacing it, not detaching first).
 */
export async function pickProject() {
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

/** Picks the agent CLI the chat runs, and remembers the choice. Clears any
 *  selected provider profile — exactly one backend answers a turn. */
export function chooseProvider(id: string | null) {
  State.agentCli = id;
  State.selectedProvider = null;
  void Bridge.agentSetCli(id);
  State.notify();
}

/** Picks a chat-only provider profile (no tools) — clears any selected
 *  agent CLI, the same mutual-exclusion `chooseProvider` enforces the other
 *  way. Not remembered across restarts the way the CLI choice is: provider
 *  profiles are a Fase 1 addition and that's outside this change's scope. */
export function chooseProviderProfile(id: string | null) {
  State.selectedProvider = id;
  State.agentCli = null;
  State.notify();
}

/** Refreshes the saved provider profiles and the Ollama auto-detection —
 *  called when the chat's provider picker opens, so a profile created or
 *  removed elsewhere (or Ollama starting/stopping) shows up without a
 *  restart. */
export async function reloadProviders() {
  availableProviders = (await Bridge.providerList()) ?? [];
  ollamaModels = (await Bridge.ollamaDetect()) ?? [];
  openjarvis = (await Bridge.openjarvisDetect()) ?? null;
}

/** The label shown in the chat header for the current agent or provider. */
export function providerLabel(): string {
  const cli = availableClis.find((c) => c.id === State.agentCli);
  if (cli) return cli.label;
  const profile = availableProviders.find((p) => p.id === State.selectedProvider);
  if (profile) return profile.label;
  return availableClis.length === 0 ? t("chat.noAgentFound") : t("chat.pickAgent");
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
