// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Settings } from "./state";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[coucou] ${cmd} failed`, err);
    return null;
  }
}

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  version: string;
  hookPath: string;
  /** False where the OS has no global cursor (Wayland): see Island.followPageCursor. */
  cursorPoll: boolean;
}

export const Bridge = {
  boot: () => call<BootInfo>("boot"),

  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),

  /** Shrink the window down to the invisible wake strip (hidden) or back to full. */
  setCollapsed: (collapsed: boolean) => call<void>("set_collapsed", { collapsed }),

  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),

  /** Give the window keyboard focus (chat field) and take it away again. */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),

  reposition: () => call<void>("reposition"),

  openUrl: (url: string) => call<void>("open_url", { url }),

  /** "Open terminal" → opens the folder in VS Code when `code` is on PATH. */
  openInVSCode: (path: string | null) => call<boolean>("open_in_vscode", { path }),

  quit: () => call<void>("quit_app"),

  openSettingsWindow: () => call<void>("open_settings_window"),

  /** Writes to %LOCALAPPDATA%\Coucou\coucou.log, next to the Rust lines. */
  log: (message: string) => call<void>("log_line", { message }),

  // ── Claude Code hooks ─────────────────────────────────────────────────────
  hooksStatus: () => call<HookStatus>("hooks_status"),
  /** Diff to show before anything is written. `install: false` previews removal. */
  hooksPreview: (install: boolean) => callOrThrow<HookPreview>("hooks_preview", { install }),
  /**
   * Writes ~/.claude/settings.json — only ever after an explicit click, and only
   * when the file still matches the preview the user looked at.
   */
  hooksApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("hooks_apply", { install, fingerprint }),

  approvalDecision: (requestId: string, decision: "allow" | "deny") =>
    call<void>("approval_decision", { requestId, decision }),
  /** "The card is up" — until this lands the relay only waits a moment. */
  approvalAck: (requestId: string) => call<void>("approval_ack", { requestId }),
  /** "Nobody can act on this" — Claude Code asks in the terminal right away. */
  approvalDecline: (requestId: string) => call<void>("approval_decline", { requestId }),

  // ── Chat, files, secrets ──────────────────────────────────────────────────
  /** One chat turn. The API key and any file bytes never leave Rust. */

  // ── Agent chat: the CLIs installed on this machine ────────────────────────
  /** Which agent CLIs are installed. Empty means API-only chat. */
  agentClis: () => call<CliInfo[]>("agent_clis"),
  /** What the chat comes up in: the project and CLI from the last run. */
  agentState: () => call<AgentState>("agent_state"),
  /** Remembers which CLI the chat runs. Null means none chosen yet. */
  agentSetCli: (cli: string | null) => call<void>("agent_set_cli", { cli }),
  /** What `/` can reach: the user's commands, the project's, and their skills. */
  agentCommands: () => call<SlashCommand[]>("agent_commands"),
  /** Opens the folder picker. Null when the user cancelled. */
  pickProject: () => call<string | null>("pick_project"),
  /** Attaches the folder the agent runs in. */
  attachProject: (path: string) => callOrThrow<string>("attach_project", { path }),
  detachProject: () => call<void>("detach_project"),
  /** One agent turn. Tool calls arrive separately, as ordinary hook events. */
  agentSend: (cli: string, prompt: string) =>
    callOrThrow<string>("agent_send", { cli, prompt }),
  /** Stops the turn in flight. False when the reply had already landed. */
  agentCancel: () => call<boolean>("agent_cancel"),
  /** The Obsidian vault the agent may read and write, and where it came from. */
  vaultState: () => call<VaultInfo>("vault_state"),
  /** Chooses the vault by hand. Null when the user cancelled the picker. */
  pickVault: () => call<string | null>("pick_vault"),
  /** Goes back to whatever vault Obsidian itself has open. */
  forgetVault: () => call<void>("forget_vault"),
  /** Fresh conversation, same project. */
  agentReset: () => call<void>("agent_reset"),
  /** The conversation the last run ended on. */
  chatLoad: () => call<KeptMessage[]>("chat_load"),
  /** Keeps the conversation for the next run. */
  chatKeep: (messages: KeptMessage[]) => call<void>("chat_keep", { messages }),
  /** Drops the conversation, the CLI session and the transcript together. */
  chatForget: () => call<void>("chat_forget"),
  /** Copies a dropped file into the inbox. */
  ingestFile: (path: string) => callOrThrow<DroppedFile>("ingest_file", { path }),
  /** Only ever tells you whether a key exists — never its value. */
  secretPresent: (key: string) => call<boolean>("secret_present", { key }),
  secretSet: (key: string, value: string) => callOrThrow<void>("secret_set", { key, value }),
  secretClear: (key: string) => callOrThrow<void>("secret_clear", { key }),

  // ── Integrations ──────────────────────────────────────────────────────────
  refreshIntegration: (id: string) => call<void>("refresh_integration", { id }),
  /** Opens the configured n8n instance in the browser. */
  openN8n: () => call<void>("open_n8n"),

  /** Tray → Pause. Stops the integration pollers, not just the island. */
  setPaused: (paused: boolean) => call<void>("set_paused", { paused }),
};

export interface IntegrationUpdate {
  id: string;
  data: Record<string, unknown>;
  error: string | null;
  event: { success: boolean; label: string; detail: string | null } | null;
}

export interface KeptMessage {
  role: "user" | "assistant" | "error";
  content: string;
  at: number;
  steps: string[];
}

/** The knowledge base the agent can reach. */
export interface VaultInfo {
  /** Empty when there is none. */
  path: string;
  /** "chosen" by hand, read from "obsidian", or "none". */
  source: "chosen" | "obsidian" | "none";
  /** How many vaults Obsidian knows about. */
  known: number;
}

/** An agent CLI found on this machine. */
export interface CliInfo {
  id: string;
  label: string;
  /** Where it was found — which copy is being run is worth knowing. */
  path: string;
  /** What it answered to `--version`, or "" when it did not answer. */
  version: string;
  /** Whether its reply streams and its conversation can be resumed. */
  streams: boolean;
}

/**
 * What the island is told while a turn runs: the reply as it is written, and
 * each tool as it is reached for. The reply itself comes back from `agentSend`.
 */
export type AgentTurn =
  | { kind: "text"; text: string }
  | { kind: "step"; label: string };

/** The project and CLI the chat should come up in, remembered across restarts. */
export interface AgentState {
  /** The attached project as it should be shown, or null for none. */
  project: string | null;
  /** The CLI the chat runs, by id, or null when none has been chosen. */
  cli: string | null;
  /** Whether the next message continues an existing conversation. */
  resuming: boolean;
}

/** One `/thing` the chat can send straight through to the CLI. */
export interface SlashCommand {
  name: string;
  description: string;
  source: "user" | "project" | "skill";
}

export interface DroppedFile {
  name: string;
  path: string;
  size: number;
}

export interface HookStatus {
  installed: boolean;
  settingsPath: string;
  hookPath: string;
  hookReady: boolean;
}

export interface HookPreview {
  diff: string;
  backup: string;
  settingsPath: string;
  /** Hand back to hooksApply so only the reviewed diff is ever written. */
  fingerprint: string;
}

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Coucou");
  return invoke<T>(cmd, args);
}

export type BridgeEvent =
  | { name: "cursor"; payload: { x: number; y: number } }
  | { name: "tray"; payload: string }
  | { name: "hook"; payload: Record<string, unknown> }
  | { name: "screen-changed"; payload: null };

export interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
}

/** Files dragged onto the island. Only reaches us when the window takes the mouse. */
export async function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!IS_TAURI) return () => {};
  return getCurrentWebview().onDragDropEvent((event) => {
    handler(event.payload as DragDropPayload);
  });
}

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}
