// The mock bridge: everything `core/bridge.ts` exports, backed by the
// fixtures in `src/dev/fixtures/` instead of real Tauri commands.
//
// Never imported directly. `vite.config.ts` aliases the specifier
// "*/core/bridge" to this file only under `--mode mock`, so every existing
// `import { Bridge } from "../core/bridge"` across the app — island.ts,
// agent.ts, hooks.ts, chat.ts, consoles.ts, settings/main.ts, all of it —
// resolves here without those files knowing mock mode exists. That is also
// why this file must never itself import "../core/bridge": the same alias
// would catch that import and resolve it right back to this file.
//
// `npm run build` never passes `--mode mock`, so this module is never pulled
// into a production bundle; `tests/mock-not-in-build.test.mjs` asserts that
// `dist/` contains no trace of it.

import { State } from "../core/state";
import { MOCK_CONSOLES, MOCK_LIVE_SESSIONS } from "./fixtures/consoles";
import { MOCK_ACTIVE_INTEGRATIONS, MOCK_INTEGRATION_DATA } from "./fixtures/integrations";
import { MOCK_CHAT_MESSAGES } from "./fixtures/chat";
import { MOCK_CPU, MOCK_PROCESSES, MOCK_SCENARIOS, type MockScenario } from "./fixtures/system";

export const IS_TAURI = false;

// ── URL state (see plan-v2.md § 0.2) ───────────────────────────────────────────

const params = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();

const pane = params.get("pane") === "services" ? "services" : "consoles";
const scenario: MockScenario = (["ok", "strained", "sick"] as const).includes(params.get("scenario") as MockScenario)
  ? (params.get("scenario") as MockScenario)
  : "ok";
const lang = params.get("lang") === "es" ? "es" : "en";
const chatState = params.get("state") ?? "";

console.info(`[mock] pane=${pane} scenario=${scenario} lang=${lang} state=${chatState || "(default)"}`);

// Seeded once, at module load — before `main()` runs, since every first-party
// module reaches `Bridge` through the aliased specifier and therefore imports
// this file before it imports anything that calls into it.
State.settings.activeIntegrations = pane === "services" ? [...MOCK_ACTIVE_INTEGRATIONS] : [];
// Fase 3's home card opens on `settings.homeRightPane`, not on "whichever
// pane has data" — `?pane=` has to set both, or `?pane=services` would
// populate the services fixtures but the card would still open on Consoles.
State.settings.homeRightPane = pane;
for (const [id, data] of Object.entries(MOCK_INTEGRATION_DATA)) {
  State.integrations[id] = { data, error: null, loaded: true, configured: true };
}
// `main.ts` reads `State.settings.language` right after boot and calls
// `setLocale()` with it — this is what makes `?lang=` drive the real i18n
// engine (src/i18n/index.ts), not just the cosmetic <html lang> attribute.
State.settings.language = lang;
document.documentElement.lang = lang;
// Fase 5's attachment tray (plan-v2.md § 5.4/5.5) — one of each glyph kind,
// so a single capture shows the thumbnail path and all three glyph paths at
// once. imagePreview() below returns the same placeholder PNG for any path,
// so the exact names here only matter for kindOf()'s extension sniffing.
if (chatState === "attachments") {
  State.chatAttachments = [
    { name: "captura-1.png", path: "C:\\inbox\\captura-1.png", size: 420_000 },
    { name: "informe.pdf", path: "C:\\inbox\\informe.pdf", size: 1_200_000 },
    { name: "main.ts", path: "C:\\inbox\\main.ts", size: 3_400 },
    { name: "notas.docx", path: "C:\\inbox\\notas.docx", size: 58_000 },
  ];
}
// The drop overlay (plan-v2.md § 5.2) reacts to this same flag in the real
// app (island.ts, from Tauri's own drag events) — seeding it directly is the
// only way a static capture can show it, since nothing here can simulate an
// actual OS-level drag.
if (chatState === "drop") State.fileDragOver = true;

// ── boot / settings ────────────────────────────────────────────────────────────

async function boot() {
  console.info("[mock] boot");
  return {
    settings: { ...State.settings },
    screen: { x: 0, y: 0, width: 1920, height: 1080, scale: 1, workHeight: 1040 },
    version: "0.1.1-mock",
    hookPath: "C:\\Users\\diego\\AppData\\Local\\Coucou\\bin\\coucou-hook.exe",
    cursorPoll: true,
  };
}

async function saveSettings(settings: unknown) {
  console.info("[mock] save_settings", settings);
}

async function screenInfo() {
  return { x: 0, y: 0, width: 1920, height: 1080, scale: 1, workHeight: 1040 };
}

// ── consoles / agent ──────────────────────────────────────────────────────────

async function agentClis() {
  return MOCK_CONSOLES;
}

let mockCli: string | null = "claude";

async function agentState() {
  return { project: "C:\\Users\\diego\\IdeaProjects\\coucou", cli: mockCli, resuming: true };
}

async function agentSetCli(cli: string | null) {
  console.info("[mock] agent_set_cli", cli);
  mockCli = cli;
}

async function agentCommands() {
  return [
    { name: "clear", description: "Clear the conversation", source: "user" as const },
    { name: "review", description: "Review the current diff", source: "project" as const },
  ];
}

// The first mock session's name/host/cwd feeds the one Claude Code task's
// "running now" line (see hooks.ts: only one session's metadata is kept at a
// time today — the plan's "2 sesiones en vivo" fixture is noted as a gap for
// Fase 3 in docs/plan-v2-notas.md, not invented here).
const firstSession = MOCK_LIVE_SESSIONS[0];
const claudeTask = State.tasks.find((t) => t.id === "integration_claude");
if (claudeTask && firstSession) {
  claudeTask.name = firstSession.name;
  claudeTask.host = firstSession.host;
  claudeTask.sessionCwd = firstSession.cwd;
  claudeTask.state = "working";
}

// ── chat ───────────────────────────────────────────────────────────────────────

async function chatLoad() {
  if (chatState === "empty") return [];
  return MOCK_CHAT_MESSAGES;
}

async function chatKeep(messages: unknown) {
  console.info("[mock] chat_keep", (messages as unknown[]).length, "messages");
}

async function chatForget() {
  console.info("[mock] chat_forget");
}

async function agentReset() {
  console.info("[mock] agent_reset");
}

async function agentSend(cli: string, prompt: string) {
  console.info("[mock] agent_send", cli, prompt);
  return "mock-session-id";
}

async function agentCancel() {
  return true;
}

// ── projects / folders ───────────────────────────────────────────────────────

async function pickProject() {
  return "C:\\Users\\diego\\IdeaProjects\\coucou";
}

// Empty, same as Linux today — exercises chat.ts's fallback to its Fase 4
// HTML file input rather than faking a native dialog's result.
async function pickFiles() {
  return [] as string[];
}

async function attachProject(path: string) {
  return path;
}

async function detachProject() {
  console.info("[mock] detach_project");
}

async function chatFolderState() {
  return { path: "C:\\Users\\diego\\IdeaProjects\\coucou", exists: true };
}

async function pickChatFolder() {
  return "C:\\Users\\diego\\IdeaProjects\\coucou";
}

async function forgetChatFolder() {
  console.info("[mock] forget_chat_folder");
}

// ── vault ─────────────────────────────────────────────────────────────────────

async function vaultState() {
  return {
    path: "C:\\Users\\diego\\OneDrive\\Documentos\\Obsidian Vault",
    source: "obsidian" as const,
    known: 1,
  };
}

async function pickVault() {
  return "C:\\Users\\diego\\OneDrive\\Documentos\\Obsidian Vault";
}

async function forgetVault() {
  console.info("[mock] forget_vault");
}

// ── system ────────────────────────────────────────────────────────────────────

async function systemStats() {
  return MOCK_SCENARIOS[scenario];
}

async function systemProcesses() {
  return MOCK_PROCESSES;
}

async function systemKillProcess(pid: number) {
  console.info("[mock] system_kill_process", pid);
}

async function systemOpenDiskCleanup() {
  console.info("[mock] system_open_disk_cleanup");
  return true;
}

async function systemScan(ids: string[]) {
  return ids.map((id) => ({
    id,
    label: id,
    about: "Mock cleanable target.",
    path: `C:\\Users\\diego\\AppData\\Local\\Temp\\${id}`,
    files: 42,
    bytes: 128 * 1024 * 1024,
    note: "",
  }));
}

async function systemClean(ids: string[]) {
  return ids.map((id) => ({ id, files: 42, bytes: 128 * 1024 * 1024, inUse: 1 }));
}

// ── files / images ───────────────────────────────────────────────────────────

async function ingestFile(path: string) {
  const name = path.split(/[\\/]/).pop() ?? path;
  return { name, path: `C:\\Users\\diego\\AppData\\Local\\Coucou\\inbox\\${name}`, size: 48_000 };
}

async function imagePreview(_path: string) {
  // 1×1 transparent PNG — enough for the UI to have something to draw.
  return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
}

async function pasteImage(media: string, bytes: number[]) {
  console.info("[mock] paste_image", media, bytes.length, "bytes");
  return { name: "pasted.png", path: "C:\\Users\\diego\\AppData\\Local\\Coucou\\inbox\\pasted.png", size: bytes.length };
}

// ── secrets ───────────────────────────────────────────────────────────────────

async function secretPresent(_key: string) {
  return false;
}

async function secretSet(key: string, _value: string) {
  console.info("[mock] secret_set", key);
}

async function secretClear(key: string) {
  console.info("[mock] secret_clear", key);
}

// ── hooks ─────────────────────────────────────────────────────────────────────

async function hooksStatus() {
  return {
    installed: true,
    settingsPath: "C:\\Users\\diego\\.claude\\settings.json",
    hookPath: "C:\\Users\\diego\\AppData\\Local\\Coucou\\bin\\coucou-hook.exe",
    hookReady: true,
  };
}

async function hooksPreview(install: boolean) {
  return {
    diff: install ? "+ coucou hooks" : "- coucou hooks",
    backup: "C:\\Users\\diego\\.claude\\settings.json.bak",
    settingsPath: "C:\\Users\\diego\\.claude\\settings.json",
    fingerprint: "mock-fingerprint",
  };
}

async function hooksApply(install: boolean, fingerprint: string) {
  console.info("[mock] hooks_apply", install, fingerprint);
  return "C:\\Users\\diego\\.claude\\settings.json.bak";
}

// ── misc no-ops (logged, so a QA pass can see every call that happened) ───────

const noop = (name: string) => async (...args: unknown[]) => {
  console.info(`[mock] ${name}`, ...args);
};

export const Bridge = {
  boot,
  screenInfo,
  saveSettings,
  setCollapsed: noop("set_collapsed"),
  setIslandRect: noop("set_island_rect"),
  focusWindow: noop("focus_window"),
  reposition: noop("reposition"),
  openUrl: noop("open_url"),
  openInVSCode: async (path: string | null) => {
    console.info("[mock] open_in_vscode", path);
    return true;
  },
  quit: noop("quit_app"),
  openSettingsWindow: noop("open_settings_window"),
  log: noop("log_line"),

  hooksStatus,
  hooksPreview,
  hooksApply,

  approvalDecision: noop("approval_decision"),
  approvalAck: noop("approval_ack"),
  approvalDecline: noop("approval_decline"),

  agentClis,
  agentState,
  agentSetCli,
  agentCommands,
  pickProject,
  pickFiles,
  attachProject,
  detachProject,
  agentSend,
  agentCancel,
  vaultState,
  pickVault,
  forgetVault,
  systemStats,
  systemScan,
  systemClean,
  systemProcesses,
  systemKillProcess,
  systemOpenDiskCleanup,
  chatFolderState,
  pickChatFolder,
  forgetChatFolder,
  agentReset,
  chatLoad,
  chatKeep,
  chatForget,
  ingestFile,
  imagePreview,
  pasteImage,
  secretPresent,
  secretSet,
  secretClear,

  refreshIntegration: noop("refresh_integration"),
  openN8n: noop("open_n8n"),
  setPaused: noop("set_paused"),
};

// ── events ────────────────────────────────────────────────────────────────────

/** CPU/RAM fixture for whatever Fase 7 wires up to read it meanwhile. */
export const MOCK_HEALTH = { cpu: MOCK_CPU[scenario], scenario };

export async function onEvent<T>(_name: string, _handler: (payload: T) => void) {
  // No fixture emits events yet — boot-time data covers Fase 0's four views.
  // Later phases (console rescans, health changes, hook sessions) add fixture
  // event sources here as the views that need them are built.
  return () => {};
}

export async function onDragDrop(_handler: (e: { type: string; paths?: string[] }) => void) {
  return () => {};
}
