// App state — mirror of AppState.swift (the parts the island needs).

import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../mochi/engine";
import type { ChatAttachment, DroppedFile, HealthEvent } from "./bridge";

export type AgentSource = "claudeCode" | "n8n" | "agent";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
  /** Where the session runs — "Windows Terminal", "VS Code"… Empty until known. */
  host?: string;
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  tool: string;
  command: string;
}

export interface ChatMessage {
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

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

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

export const TOGGLEABLE_INTEGRATION_IDS = [
  "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  "integration_notion", "integration_calcom", "integration_stripe",
];

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  absenceInterval: number;
  activeIntegrations: string[];
  screen: "primary" | "cursor";
  autostart: boolean;
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
}

/** One entry of the quick assistant's app allow-list. */
export interface AllowedApp {
  id: string;
  label: string;
  exe: string;
}

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
};

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

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

  noteMessage: string | null = null;
  searchResult: SearchResult | null = null;
  chatHistory: ChatMessage[] = [];
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

  integrations: Record<string, IntegrationInfo> = {};

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    this.notify();
  }

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

  defaultView(): IslandViewName {
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
