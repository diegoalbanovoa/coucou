// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { AllowedApp, Settings } from "./state";

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

export interface ScreenInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  /** How tall the island can grow (logical px) before it would cover the
   *  taskbar — see src-tauri/src/island.rs's screen_info, which this mirrors.
   *  core/layout.ts's chatPromptHeight clamps against it. */
  workHeight: number;
}

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: ScreenInfo;
  version: string;
  hookPath: string;
  /** False where the OS has no global cursor (Wayland): see Island.followPageCursor. */
  cursorPoll: boolean;
}

export const Bridge = {
  boot: () => call<BootInfo>("boot"),

  /** Re-read after a "screen-changed" event — resolution/work-area can only
   *  change between calls, never during boot's. */
  screenInfo: () => call<ScreenInfo>("screen_info"),

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
  agentClis: () => call<Console[]>("agent_clis"),
  /** What the chat comes up in: the project and CLI from the last run. */
  agentState: () => call<AgentState>("agent_state"),
  /** Remembers which CLI the chat runs. Null means none chosen yet. */
  agentSetCli: (cli: string | null) => call<void>("agent_set_cli", { cli }),
  /** What `/` can reach: the user's commands, the project's, and their skills. */
  agentCommands: () => call<SlashCommand[]>("agent_commands"),
  /** Opens the folder picker. Null when the user cancelled. */
  pickProject: () => call<string | null>("pick_project"),

  /** The paperclip's native picker — any file, any number. `call()` already
   *  turns "not in Tauri" into null; empty on Linux too (platform/linux.rs
   *  doesn't build one this pass), which chat.ts's attachBtn reads the same
   *  way as a cancel: fall back to its Fase 4 HTML file input. */
  pickFiles: () => call<string[]>("pick_files"),
  /** Attaches the folder the agent runs in. */
  attachProject: (path: string) => callOrThrow<string>("attach_project", { path }),
  detachProject: () => call<void>("detach_project"),
  /** One agent turn. Tool calls arrive separately, as ordinary hook events. */
  agentSend: (cli: string, prompt: string) =>
    callOrThrow<string>("agent_send", { cli, prompt }),
  /** Stops the turn in flight — whichever backend, CLI or provider profile,
   *  is answering it. False when the reply had already landed. */
  agentCancel: () => call<boolean>("agent_cancel"),
  /** Every saved provider profile. */
  providerList: () => call<ProviderProfile[]>("provider_list"),
  /** Creates (no `id`) or updates (with one) a profile. The key is set
   *  separately through `secretSet(providerKeyFor(id), ...)`. */
  providerSave: (profile: { id?: string; label: string; baseUrl: string; model: string }) =>
    callOrThrow<ProviderProfile>("provider_save", { input: profile }),
  /** Deletes the profile and its stored key together. */
  providerDelete: (id: string) => callOrThrow<void>("provider_delete", { id }),
  /** One turn through a provider profile — no tools. Streams on the same
   *  "agent-turn" event an agent-CLI turn uses. */
  providerSend: (profileId: string, prompt: string, history: { role: "user" | "assistant"; content: string }[]) =>
    callOrThrow<string>("provider_send", { profileId, prompt, history }),
  /** The models a local Ollama server has, or an empty list if none
   *  answers — checked only when the picker opens. */
  ollamaDetect: () => call<OllamaModel[]>("ollama_detect"),
  /** The Obsidian vault the agent may read and write, and where it came from. */
  vaultState: () => call<VaultInfo>("vault_state"),
  /** Chooses the vault by hand. Null when the user cancelled the picker. */
  pickVault: () => call<string | null>("pick_vault"),
  /** Goes back to whatever vault Obsidian itself has open. */
  forgetVault: () => call<void>("forget_vault"),
  /** Free space per drive and memory in use. Asked on a timer while the tab is open. */
  systemStats: () => call<Stats>("system_stats"),
  /** What cleaning these would remove. Deletes nothing — this is the preview. */
  systemScan: (ids: string[]) => call<Found[]>("system_scan", { ids }),
  /** Deletes what the preview said, re-checking every file against the guard. */
  systemClean: (ids: string[]) => call<Swept[]>("system_clean", { ids }),
  /** The heaviest processes right now, ungrouped — see `groupProcesses`. */
  systemProcesses: () => call<ProcInfo[]>("system_processes"),
  /** Turns, latency, tokens and reported cost per backend, this session only
   *  (kept in memory by Rust, never written anywhere). */
  usageSummary: () => call<BackendSummary[]>("usage_summary"),
  usageReset: () => call<void>("usage_reset"),
  /** Pinned notes for the provider chat. Stored by Rust, never a key. */
  memoryNotes: () => call<MemoryNote[]>("memory_notes"),
  memoryAdd: (text: string) => callOrThrow<MemoryNote>("memory_add", { text }),
  memoryDelete: (id: string) => callOrThrow<void>("memory_delete", { id }),
  memoryClear: () => callOrThrow<void>("memory_clear"),
  /** The folder the notes live in, shown as plain text. */
  memoryPath: () => call<string>("memory_path"),
  /** Ends the named ones. Refused in Rust, not only hidden here, for anything
   *  protected or whose startTime no longer matches the pid. Returns the
   *  pids that could not be ended. */
  systemEndProcess: (targets: EndTarget[]) => call<number[]>("system_end_process", { targets }),
  /** Windows' own Disk Cleanup. False on Linux, or if it would not start. */
  systemOpenDiskCleanup: () => call<boolean>("system_open_disk_cleanup"),
  /** The health monitor's last reading, for a window that just opened rather
   *  than wait out the next heartbeat. Null once settled at `ok` the first
   *  time — there is nothing to say yet. */
  healthState: () => call<HealthEvent | null>("health_state"),
  /** Where the chat runs with nothing attached, and whether it is still there. */
  chatFolderState: () => call<FolderState>("chat_folder_state"),
  /** Chooses that folder. Null when the user cancelled the picker. */
  pickChatFolder: () => call<string | null>("pick_chat_folder"),
  /** Clears it: the chat then needs a project attached by hand. */
  forgetChatFolder: () => call<void>("forget_chat_folder"),
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
  /** One inbox image as a data URI. Refused for anything outside the inbox. */
  imagePreview: (path: string) => callOrThrow<string>("image_preview", { path }),
  /** An image pasted from the clipboard, which arrives as bytes not a path. */
  pasteImage: (media: string, bytes: number[]) =>
    callOrThrow<DroppedFile>("paste_image", { media, bytes }),
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

  // ── Quick assistant (openspec/changes/quick-assistant-tools) ──────────────
  /** One quick-ask turn. Rejects with a `<kind>:<detail>` string. Tool calls
   *  show their approval card through the ordinary "hook" event. */
  quickAsk: (prompt: string) => callOrThrow<string>("quick_ask", { prompt }),
  /** Whether the global shortcut took, and why not when it did not. */
  quickShortcutStatus: () => call<ShortcutInfo>("quick_shortcut_status"),
  /** Stores and registers the shortcut; null clears it. A conflict comes back
   *  in the result (`registered: false`), not as a rejection. */
  quickShortcutSet: (shortcut: string | null) => call<ShortcutInfo>("quick_shortcut_set", { shortcut }),
  quickFolders: () => call<string[]>("quick_folders"),
  /** Opens the folder picker and allow-lists the choice. Null on cancel. */
  quickFolderAdd: () => call<string | null>("quick_folder_add"),
  quickFolderRemove: (path: string) => call<void>("quick_folder_remove", { path }),
  quickApps: () => call<AllowedApp[]>("quick_apps"),
  /** Opens the file picker on an executable and allow-lists it. Null on cancel. */
  quickAppAdd: () => call<AllowedApp | null>("quick_app_add"),
  quickAppRemove: (id: string) => call<void>("quick_app_remove", { id }),
  /** The newest action-log entries, oldest first. */
  quickLog: (limit?: number) => call<QuickLogEntry[]>("quick_log", { limit }),
};

export interface IntegrationUpdate {
  id: string;
  data: Record<string, unknown>;
  error: string | null;
  event: { success: boolean; label: string; detail: string | null } | null;
}

/** What a message carried, never the bytes — `id` is the inbox path, the
 *  same string `imagePreview` takes to ask for a thumbnail again. */
export interface ChatAttachment {
  id: string;
  name: string;
  kind: "image" | "pdf" | "code" | "doc" | "other";
  size: number;
}

export interface KeptMessage {
  role: "user" | "assistant" | "error";
  content: string;
  at: number;
  steps: string[];
  attachments: ChatAttachment[];
}

/** One drive and the room left on it. */
export interface Drive {
  /** "C:" on Windows, the mount point on Linux. */
  name: string;
  free: number;
  total: number;
}

/** The health monitor's level — a mood for Mochi, not a system state. See
 *  src-tauri/src/health.rs and mochi/moods.ts. */
export type HealthLevel = "ok" | "strained" | "sick";
export type HealthCause = "cpu" | "memory" | "disk";

export interface HealthEvent {
  level: HealthLevel;
  cause: HealthCause;
  cpu: number;
  memory: number;
  disk: number;
}

/** A note the user pinned for the provider chat (memory.rs's `Note`). */
export interface MemoryNote {
  id: string;
  at: number;
  text: string;
}

/** One backend's row of the Usage pane (usage.rs's `BackendSummary`). A field
 *  that is `null` was never reported by the source: it is omitted from the
 *  row, never shown as zero. */
export interface BackendSummary {
  /** `cli:<id>`, `provider:<id>` or `quick:<id>`. */
  backend: string;
  label: string;
  turns: number;
  errors: number;
  p50FirstTextMs: number | null;
  p50TotalMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

/** What the System tab reads. */
export interface Stats {
  drives: Drive[];
  memoryUsed: number;
  memoryTotal: number;
  /** 0 to 100 — a delta since the previous call, so the very first reading
   *  of a run is always 0. */
  cpuPercent: number;
  cores: number;
  /** Whether "Open Disk Cleanup" does anything on this machine. */
  diskCleanupAvailable: boolean;
}

/** One running process, heaviest first in the list the tab is given.
 *  `protected` ones are still listed, just never offered a close button —
 *  see `groupProcesses` for turning this flat list into the tab's rows. */
export interface ProcInfo {
  pid: number;
  name: string;
  memory: number;
  protected: boolean;
  /** Opaque — carried right back in an `EndTarget`, read nowhere else.
   *  A string, not a number: on Windows this is a raw FILETIME (~1.3e17
   *  today), well past `Number.MAX_SAFE_INTEGER` (2^53 ≈ 9e15) — a JSON
   *  number would silently round it to a different integer, and the
   *  pid-reuse check on the way back would then refuse every close. See
   *  `system.rs`'s own note on `ProcInfo.start_time`. */
  startTime: string;
}

/** The pid and startTime a row's close button was drawn with — Rust refuses
 *  the request if a different process has since taken that pid. */
export interface EndTarget {
  pid: number;
  startTime: string;
}

/** What one cleanable thing holds, as the preview reports it. */
export interface Found {
  id: string;
  label: string;
  about: string;
  /** Empty when it is not on this machine. */
  path: string;
  files: number;
  bytes: number;
  /** Why there is nothing to do, when there is nothing to do. */
  note: string;
}

/** What one of them actually gave up. */
export interface Swept {
  id: string;
  files: number;
  bytes: number;
  /** Skipped because something else had them open. */
  inUse: number;
}

/** A folder setting, and whether what it points at is still there. */
export interface FolderState {
  /** Empty when none is set. */
  path: string;
  /** False when it is set but no longer a folder. */
  exists: boolean;
}

/** A chat-only provider profile (OpenRouter, Ollama, LM Studio, LiteLLM,
 *  any OpenAI-compatible endpoint) — no tools, ever. See
 *  openspec/changes/provider-chat-profiles. `keySet` is whether a key is
 *  stored, never the key itself. */
export interface ProviderProfile {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  keySet: boolean;
}

/** The OS-keychain key for a provider profile's own API key — pass to the
 *  existing `secretPresent`/`secretSet`/`secretClear` (the same commands
 *  the 9 fixed secrets already use); there is no provider-specific key
 *  command. Must match `providers::key_for` in Rust exactly. */
export function providerKeyFor(id: string): string {
  return `provider-profile-${id}-api-key`;
}

/** What the settings window shows about the quick assistant's shortcut. */
export interface ShortcutInfo {
  shortcut: string | null;
  registered: boolean;
  error: string | null;
}

/** One line of the quick assistant's local action log. */
export interface QuickLogEntry {
  /** Milliseconds since the epoch. */
  at: number;
  tool: string;
  target: string;
  /** "approved" | "denied" | "auto-approved" | "refused-paused" | "refused-scope" */
  outcome: string;
}

/** A model Ollama has installed locally, from auto-detection. */
export interface OllamaModel {
  name: string;
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

/** What a console can do. Three separate claims, not one. */
export interface Capabilities {
  /** Its reply can be read as it is written. */
  streaming: boolean;
  /** A second message carries on the same conversation. */
  resume: boolean;
  /** Its tool calls reach the island, so they can be approved there. */
  approvable: boolean;
}

/** One agent console installed on this machine. */
export interface Console {
  id: string;
  label: string;
  /** Where it was found — which copy is being run is worth knowing. */
  path: string;
  /** What it answered to `--version`, or "" when it did not answer. */
  version: string;
  /** The colour its Mochi wears in the picker. */
  color: string;
  can: Capabilities;
  /** Whether it has ever been run from Coucou, or only read about. */
  verified: boolean;
  /** Its config file — extra flags, turn timeout, extra folders. */
  configPath: string;
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
