/**
 * App state — mirror of AppState.swift (the parts the island needs).
 *
 * One mutable singleton (`State`) holds everything the island renders from:
 * tasks (pills), the current view/mode, chat, settings and integration data.
 * Mutators call `notify()`; the island subscribes once and re-renders on the
 * next frame, so views read `State` directly and never keep their own copy.
 * Also defines `Settings`/`DEFAULT_SETTINGS`, which must stay in step with
 * `Settings` in src-tauri/src/settings.rs.
 */

import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../mochi/engine";
import type { ChatAttachment, DroppedFile, HealthEvent, RoutineResult } from "./bridge";

/** Where a pill's events come from: Claude Code hooks, an n8n-style poller, or another agent CLI. */
export type AgentSource = "claudeCode" | "n8n" | "agent";
/** The small marker on a pill that needs attention. Cleared when the pill is focused. */
export type PillBadge = "approval" | "finished" | "error";

/** One pill: an agent session or an integration, with Mochi's state for it. */
export interface AgentTask {
  /** Stable id: `integration_*` for fixed pills, `agent_*` for dynamic ones. */
  id: string;
  name: string;
  /** Hex accent colour of the pill. */
  color: string;
  state: BotStateName;
  /** Index into `steps` of the step currently shown. */
  stepIndex: number;
  /** Recent tool steps, capped at 20 by `appendStep`. */
  steps: string[];
  source: AgentSource;
  /** True for the fixed pills in `INTEGRATION_AGENTS`; false for dynamic agent pills. */
  isIntegration: boolean;
  /** One-shot emote overriding the state animation, if any. */
  emote?: BotEmoteName | null;
  /** Eye shape of the pill's mini Mochi. */
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  /** Working directory of the session, from the hook payload. */
  sessionCwd?: string | null;
  /** Where the session runs — "Windows Terminal", "VS Code"… Empty until known. */
  host?: string;
}

/** A permission request waiting for the user's explicit click. */
export interface ApprovalInfo {
  /** Echoed back to `Bridge.approvalDecision` to resolve the right request. */
  requestId: string;
  sessionId: string;
  tool: string;
  /** What the tool wants to run, shown on the card. */
  command: string;
}

/** One message in the on-screen chat log. */
export interface ChatMessage {
  /** Local counter, unique within a run. */
  id: number;
  /** `error` is a turn that failed: shown in the log, not as a note view. */
  role: "user" | "assistant" | "error";
  content: string;
  /** When it landed, for the hover title. */
  at: number;
  /** The tools the agent reached for, in order. Assistant turns only. */
  steps?: string[];
  /** What rode along with this message — user turns only. Shown as 48px
   *  chips above the text (views/chat.ts's bubble()); never the bytes, see
   *  src-tauri/src/transcript.rs's own Attachment. */
  attachments?: ChatAttachment[];
}

/** One row of a search result card; `url`, when present, makes it clickable. */
export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

/** Content of the "result" view. */
export interface SearchResult {
  title: string;
  items: ResultItem[];
  /** Footnote under the list. */
  note?: string;
}

/** Builds an idle, empty integration pill (used only for `INTEGRATION_AGENTS`). */
const task = (
  id: string, name: string, color: string, source: AgentSource,
): AgentTask => ({
  id, name, color, state: "idle", stepIndex: 0, steps: [], source, isIntegration: true,
});

/** AgentTask.integrationAgents — same ids, names and colours as macOS. */
export const INTEGRATION_AGENTS: AgentTask[] = [
  // "Claude Code" is the agent; where it runs is `host`, filled in from the
  // first hook event of a session. This used to read "VS Code", inherited from
  // the Mac, where the pill really was the editor — on Windows a session comes
  // from whatever terminal the user happens to be in.
  task("integration_claude", "Claude Code", "#F5F6F8", "claudeCode"),
  task("integration_resend", "Resend", "#22C55E", "n8n"),
  task("integration_n8n", "n8n", "#F29B38", "n8n"),
  task("integration_vercel", "Vercel", "#7C5CFF", "n8n"),
  task("integration_github", "GitHub", "#F4505E", "n8n"),
  task("integration_notion", "Notion", "#8C8C8C", "n8n"),
  task("integration_calcom", "Cal.com", "#C9956A", "n8n"),
  task("integration_stripe", "Stripe", "#0570DE", "n8n"),
];

/** Integration pills the user may switch on or off; `integration_claude` is always on. */
export const TOGGLEABLE_INTEGRATION_IDS = [
  "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  "integration_notion", "integration_calcom", "integration_stripe",
];

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  /** True once at least one poll has come back. */
  loaded: boolean;
  /** False when the integration has no credentials yet. */
  configured: boolean;
}

/** User settings, persisted by Rust. Field names match the serde struct (camelCase). */
export interface Settings {
  soundEnabled: boolean;
  /** 0 to 1. */
  soundVolume: number;
  /** Seconds before an expanded island collapses by itself. */
  autoCloseInterval: number;
  /** Seconds of inactivity before Mochi goes to sleep. */
  absenceInterval: number;
  /** Ids of the optional integration pills currently on (max 4). */
  activeIntegrations: string[];
  /** Which monitor the island sits on: the primary one or the one under the cursor. */
  screen: "primary" | "cursor";
  /** Launch with the OS. */
  autostart: boolean;
  /** Whether the user has installed the Claude Code hooks. */
  hooksInstalled: boolean;
  /** The folder the chat runs in, remembered across restarts. Null for none. */
  projectRoot: string | null;
  /** Which agent CLI the chat runs, by id. Null means the API chat. */
  agentCli: string | null;
  /** The CLI conversation being continued, if there is one. */
  agentSession: string | null;
  /** The Obsidian vault chosen by hand, or null to use the one Obsidian has. */
  vaultPath: string | null;
  /** Where the chat runs when no project is attached. Null for nowhere. */
  defaultChatFolder: string | null;
  /** "system" follows `navigator.languages`; see i18n/index.ts's resolveLocale. */
  language: "system" | "en" | "es";
  /** Which pane the overview's right card opens on — see docs/plan-v2.md § 3.3. */
  homeRightPane: "consoles" | "services";

  /** Whether Mochi reacts to the machine's load at all. */
  healthEnabled: boolean;
  /** 50 to 95 — the load percent that, held, takes Mochi from `ok` to
   *  `strained`. `sick`'s own threshold is not configured directly; see
   *  src-tauri/src/health.rs's file note for why it is always this + 15. */
  healthThreshold: number;
  healthIncludeDisk: boolean;
  /** 70 to 98 — ignored unless `healthIncludeDisk` is on. */
  healthDiskThreshold: number;
  /** Whether worsening briefly reveals the collapsed island. */
  healthNotify: boolean;

  /** Global shortcut that opens the quick assistant, e.g. "ctrl+shift+space". Null for none. */
  quickAssistantShortcut: string | null;
  /** The provider profile (id) the quick assistant talks to. Null means no model. */
  quickAssistantProfile: string | null;
  /** Folders search_files / read_approved_folder may reach. */
  quickAssistantFolders: string[];
  /** Apps open_app may launch. */
  quickAssistantApps: AllowedApp[];

  /** Memory for the provider chat (plan v4, Fase 5). Off by default. */
  memoryEnabled: boolean;
  /** One extra model call when the conversation outgrows the context budget. */
  memoryAutoSummary: boolean;

  /** Names of the imported skills the quick assistant may load (Fase 6). */
  skillsEnabled: string[];
}

/** One entry of the quick assistant's app allow-list. */
export interface AllowedApp {
  id: string;
  label: string;
  exe: string;
}

/** Defaults used until `boot` returns the saved settings; keep in step with Rust's `Settings::default()`. */
export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  absenceInterval: 180,
  activeIntegrations: [
    "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  ],
  screen: "primary",
  // Mirrors Settings::default() in settings.rs: the app is only useful if it is
  // there when something needs answering.
  autostart: true,
  hooksInstalled: false,
  projectRoot: null,
  agentCli: null,
  agentSession: null,
  vaultPath: null,
  defaultChatFolder: null,
  language: "system",
  homeRightPane: "consoles",
  // Mirrors Settings::default() in settings.rs.
  healthEnabled: true,
  healthThreshold: 70,
  healthIncludeDisk: false,
  healthDiskThreshold: 90,
  healthNotify: true,
  quickAssistantShortcut: null,
  quickAssistantProfile: null,
  quickAssistantFolders: [],
  quickAssistantApps: [],
  memoryEnabled: false,
  memoryAutoSummary: false,
  skillsEnabled: [],
};

/** Callback run by `notify()`. */
type Listener = () => void;

/**
 * The mutable app state behind the `State` singleton. Fields are plain and
 * public by design: writers change them and then call `notify()` (the setters
 * below already do). Not persisted — only `settings` round-trips through Rust.
 */
class AppState {
  /** Collapse level of the island (hidden / compact / expanded). */
  mode: IslandMode = "hidden";
  /** Which view is drawn while expanded. */
  view: IslandViewName = "overview";

  /** Pills in display order; see `loadIntegrationTasks` for the ordering rules. */
  tasks: AgentTask[] = [];
  /** Id of the pill Mochi follows. Falls back to the first task when stale. */
  focusId: string | null = null;

  /** Forces Mochi's state regardless of the focused task (dev/mock mode, health). */
  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  /** Keeps the island open (no auto-collapse) while true. */
  isPinned = false;
  /** Tray "Pause": integration pollers are stopped and tools refused. */
  paused = false;

  /** A file is being dragged over the island. */
  fileDragOver = false;

  /** Mock mode only (`?state=cleanup`) — opens the System tab's "free up
   *  space" sheet already on its results step, since neither a real click
   *  nor a wait for a real scan can be driven from shots.mjs. */
  systemOpenCleanupSheet = false;

  /** Mock mode only (`?state=storage`) — starts the System tab on its
   *  Almacenamiento pane instead of the Procesos default, so shots.mjs can
   *  capture the drive list without scripting a segmented-control click. */
  systemInitialPane: "processes" | "storage" | null = null;

  /** The health monitor's last reading — null until the first one arrives
   *  (or the user has it switched off). A mood, not a machine state: see
   *  mochi/moods.ts and plan-v2.md § 7.3. */
  health: HealthEvent | null = null;

  /** Text of the "note" view. */
  noteMessage: string | null = null;
  /** Content of the "result" view. */
  searchResult: SearchResult | null = null;
  /** The chat log, oldest first. */
  chatHistory: ChatMessage[] = [];
  /** The permission request currently on the approval card, if any. */
  pendingApproval: ApprovalInfo | null = null;
  /** Folder the agent runs in, or null when nothing is attached. */
  attachedProject: string | null = null;
  /** Which CLI the chat runs, or null for none selected. Mutually exclusive
   *  with `selectedProvider` — see `island/agent.ts`'s `chooseProvider` and
   *  `chooseProviderProfile`, the only two places either is set. */
  agentCli: string | null = null;
  /** Which chat-only provider profile (openspec/changes/provider-chat-profiles)
   *  the chat runs through — no tools, ever. Mutually exclusive with
   *  `agentCli`: exactly one backend answers a turn. */
  selectedProvider: string | null = null;
  /** The reply being written, as the agent streams it. */
  chatDraft = "";
  /** What the turn in flight has done so far, newest last. */
  chatSteps: string[] = [];
  /** Whether the chat is using all the height the display allows. */
  chatExpanded = false;
  /** The work area of the monitor the island is on (logical px, taskbar
   *  excluded) — `core/bridge.ts`'s `ScreenInfo.workHeight`, refreshed on
   *  boot and on every "screen-changed" event. `core/layout.ts`'s
   *  `islandSize`/`chatPromptHeight` clamp every view's height against it so
   *  the native window (fixed at `PANEL_H`) never has to draw past the
   *  display it is actually on. 1080 until boot resolves it. */
  workAreaHeight = 1080;
  /** The find bar's query. Null when it is closed. */
  chatQuery: string | null = null;
  /** Files attached to the message being written — any kind (5.4), not just
   *  images; kindOf() in views/chat.ts sorts a dropped/picked/pasted one into
   *  the right tray glyph. Not sent until the message is. */
  chatAttachments: DroppedFile[] = [];

  /** Whether a chat turn is in flight (views/chat.ts sets it). A routine's
   *  digest never opens over one. */
  chatSending = false;
  /** The last routine result that ran to an end (plan v4, Fase 7). */
  lastRoutineResult: RoutineResult | null = null;
  /** A digest is waiting for the island to be collapsed and idle. */
  pendingDigest = false;

  /** Latest poller report per integration id. */
  integrations: Record<string, IntegrationInfo> = {};

  /** `performance.now()` of the last user/agent activity; drives auto-close and sleep. */
  lastActivity = performance.now();

  /** Live copy of the settings; replaced by `boot`, saved through `Bridge.saveSettings`. */
  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  /** Registers a re-render callback; returns the unsubscribe function. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  /** The pill Mochi follows: `focusId` if it still exists, else the first task. */
  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  /** The state Mochi should show: the override, else the focused task's, else idle. */
  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  /** Every pill except the focused one (the side pills in the overview). */
  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  /** Focuses a pill and clears its badge (looking at it counts as seen). Unknown ids are ignored. */
  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    this.notify();
  }

  /** Sets a pill's Mochi state. Unknown ids are ignored. */
  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  /** Appends a tool step to a pill, keeping only the newest 20, and points `stepIndex` at it. */
  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    this.notify();
  }

  /** Sets or clears a pill's attention badge. */
  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /** loadIntegrationTasks() — VS Code always on, the rest opt-in (max 4). */
  loadIntegrationTasks() {
    for (const proto of INTEGRATION_AGENTS) {
      const shouldLoad =
        proto.id === "integration_claude" || this.settings.activeIntegrations.includes(proto.id);
      const idx = this.tasks.findIndex((t) => t.id === proto.id);
      if (shouldLoad && idx < 0) this.tasks.push({ ...proto, steps: [] });
      if (!shouldLoad && idx >= 0) this.tasks.splice(idx, 1);
    }
    // Order: integration_claude first, then agent_* pills (visible in slice(0,4)),
    // then other integrations in declaration order.
    const order = INTEGRATION_AGENTS.map((t) => t.id);
    this.tasks.sort((a, b) => {
      const isAgentA = a.id.startsWith("agent_");
      const isAgentB = b.id.startsWith("agent_");
      // integration_claude always first
      if (a.id === "integration_claude") return -1;
      if (b.id === "integration_claude") return 1;
      // agent_* before other integrations; preserve insertion order among themselves
      if (isAgentA && !isAgentB) return -1;
      if (isAgentB && !isAgentA) return 1;
      if (isAgentA && isAgentB) return 0;
      // both known integrations → declaration order
      return order.indexOf(a.id) - order.indexOf(b.id);
    });
    if (!this.focusId) this.focusId = "integration_claude";
    this.notify();
  }

  /** Drops a pill; if it was focused, focus moves to the first remaining one. */
  removeTask(id: string) {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.tasks.splice(idx, 1);
    if (this.focusId === id) this.focusId = this.tasks[0]?.id ?? "integration_claude";
    this.notify();
  }

  /** Creates a dynamic agent_ pill on first event; no-ops if it already exists.
   *  Inserted right after integration_claude so it appears in the visible slice(0,4). */
  upsertExternalAgent(id: string, name: string, color: string) {
    if (this.tasks.some((t) => t.id === id)) return;
    const at = this.tasks.findIndex((t) => t.id === "integration_claude") + 1;
    this.tasks.splice(at, 0, {
      id, name, color,
      state: "idle", stepIndex: 0, steps: [],
      source: "agent", isIntegration: false,
    });
    if (!this.focusId) this.focusId = id;
    this.notify();
  }

  /**
   * Switches an optional integration pill on or off, then rebuilds the task
   * list. `integration_claude` cannot be toggled and at most 4 can be on.
   */
  toggleIntegration(id: string) {
    if (id === "integration_claude") return;
    const active = this.settings.activeIntegrations;
    if (active.includes(id)) {
      this.settings.activeIntegrations = active.filter((x) => x !== id);
      if (this.focusId === id) this.focusId = "integration_claude";
    } else {
      if (active.length >= 4) return;
      this.settings.activeIntegrations = [...active, id];
    }
    this.loadIntegrationTasks();
  }

  /** The view to return to when nothing else is pending. */
  defaultView(): IslandViewName {
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

/** The app-wide state singleton; import this, never construct `AppState`. */
export const State = new AppState();
