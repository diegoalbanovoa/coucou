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
import { MOCK_ROUTINES, MOCK_ROUTINE_RESULTS } from "./fixtures/routines";
import { MOCK_CPU, MOCK_PROCESSES, MOCK_SCENARIOS, MOCK_USAGE, type MockScenario } from "./fixtures/system";

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

/** `health_state` would return in mock mode — the mood Fase 7 pairs with
 *  this same `?scenario=` the System tab's own numbers already use, so one
 *  URL param drives both Mochi's mood and the System tab shots consistently.
 *  `null` at `ok`: a real run says nothing either, since nothing needs
 *  saying — see health.rs's own file note. */
const MOCK_HEALTH_EVENT =
  scenario === "ok"
    ? null
    : {
        level: scenario,
        cause: "memory" as const,
        cpu: MOCK_CPU[scenario],
        memory: Math.round((MOCK_SCENARIOS[scenario].memoryUsed / MOCK_SCENARIOS[scenario].memoryTotal) * 100),
        disk: 20,
      };

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
// The System tab's "free up space" sheet (plan-v2.md § 6.5) — seeded open
// on its results step, since reaching it for real needs a click and a wait
// for a scan this script does not drive.
if (chatState === "cleanup") State.systemOpenCleanupSheet = true;
if (chatState === "storage") State.systemInitialPane = "storage";

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

async function providerSend(profileId: string, prompt: string, history: { role: string; content: string }[]) {
  console.info("[mock] provider_send", profileId, prompt, `${history.length} earlier messages`);
  return "mock reply";
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

async function healthState() {
  return MOCK_HEALTH_EVENT;
}

async function systemProcesses() {
  return MOCK_PROCESSES;
}

// Provider profiles: none saved and no Ollama in the browser. The mock stopped
// loading when chat.ts began importing `providerKeyFor` (provider-chat-profiles)
// without the mock exporting it; see docs/plan-v4-notas.md, Fase 4.
export function providerKeyFor(id: string): string {
  return `provider-profile-${id}-api-key`;
}

async function providerList() {
  return [] as { id: string; label: string; baseUrl: string; model: string; keySet: boolean }[];
}

async function providerSave(profile: { id?: string; label: string; baseUrl: string; model: string }) {
  console.info("[mock] provider_save", profile.label);
  return { id: profile.id ?? "mock-profile", ...profile, keySet: false };
}

async function ollamaDetect() {
  return [] as { name: string }[];
}

let usageRows = [...MOCK_USAGE];

async function usageSummary() {
  return usageRows;
}

async function usageReset() {
  usageRows = [];
}

let mockNotes: { id: string; at: number; text: string }[] = [
  { id: "n1", at: 1, text: "Mi perro se llama Toby" },
];

async function memoryNotes() {
  return mockNotes;
}

async function memoryAdd(text: string) {
  const note = { id: `n${mockNotes.length + 1}-${Date.now()}`, at: Date.now(), text: text.slice(0, 2000) };
  mockNotes = [...mockNotes, note];
  return note;
}

async function memoryDelete(id: string) {
  mockNotes = mockNotes.filter((n) => n.id !== id);
}

async function memoryClear() {
  mockNotes = [];
}

let mockRoutines = [...MOCK_ROUTINES];
let mockResults = [...MOCK_ROUTINE_RESULTS];

// `?view=digest` shows the digest view with the "done" fixture (main.ts opens it).
if (params.get("view") === "digest") State.lastRoutineResult = MOCK_ROUTINE_RESULTS[0];
if (params.get("view") === "digest-error") State.lastRoutineResult = MOCK_ROUTINE_RESULTS[1];

async function routineList() {
  return mockRoutines;
}

async function routineSave(input: Record<string, unknown>) {
  const id = (input.id as string | undefined) || `r-${Date.now()}`;
  const saved = { ...input, id } as (typeof mockRoutines)[number];
  mockRoutines = [...mockRoutines.filter((r) => r.id !== id), saved];
  return saved;
}

async function routineDelete(id: string) {
  mockRoutines = mockRoutines.filter((r) => r.id !== id);
}

async function routineRun(id: string) {
  const routine = mockRoutines.find((r) => r.id === id);
  const result = {
    routineId: id,
    label: routine?.label ?? id,
    at: Date.now(),
    ok: true,
    outcome: "done",
    text: "Mock digest: nothing ran for real.",
  };
  mockResults = [result, ...mockResults];
  return result;
}

async function routineResults(limit: number) {
  return mockResults.slice(0, limit);
}

async function routineMarkMissed(id: string) {
  const routine = mockRoutines.find((r) => r.id === id);
  const result = { routineId: id, label: routine?.label ?? id, at: Date.now(), ok: false, outcome: "missed", text: "" };
  mockResults = [result, ...mockResults];
  return result;
}

let mockSkills: { name: string; description: string; enabled: boolean; ignored: string[] }[] = [
  { name: "meeting-notes", description: "Turn rough meeting notes into decisions and action items.", enabled: true, ignored: [] },
];

async function skillList() {
  return mockSkills;
}

async function skillImport(replace: boolean) {
  const name = "pdf-tools";
  if (mockSkills.some((s) => s.name === name) && !replace) throw `exists:${name}`;
  mockSkills = mockSkills.filter((s) => s.name !== name);
  const view = { name, description: "Work with PDF files.", enabled: false, ignored: ["scripts", "allowed-tools"] };
  mockSkills = [...mockSkills, view];
  return view;
}

async function skillDelete(name: string) {
  mockSkills = mockSkills.filter((s) => s.name !== name);
}

async function skillSetEnabled(name: string, enabled: boolean) {
  mockSkills = mockSkills.map((s) => (s.name === name ? { ...s, enabled } : s));
}

async function memoryPath() {
  return "C:/Users/diego/AppData/Local/Coucou/memory";
}

async function systemEndProcess(targets: { pid: number; startTime: string }[]) {
  console.info("[mock] system_end_process", targets);
  return [] as number[];
}

async function systemOpenDiskCleanup() {
  console.info("[mock] system_open_disk_cleanup");
  return true;
}

async function systemScan(ids: string[]) {
  // `label`/`about` mirror the real `system_scan`: untranslated, internal,
  // and never shown — views/system.ts's own `targetLabel()` is what the
  // sheet actually displays, keyed by `id`.
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
  providerSend,
  providerList,
  providerSave,
  providerDelete: noop("provider_delete"),
  ollamaDetect,
  agentCancel,
  vaultState,
  pickVault,
  forgetVault,
  systemStats,
  systemScan,
  systemClean,
  systemProcesses,
  usageSummary,
  usageReset,
  memoryNotes,
  memoryAdd,
  memoryDelete,
  memoryClear,
  memoryPath,
  routineList,
  routineSave,
  routineDelete,
  routineRun,
  routineResults,
  routineMarkMissed,
  skillList,
  skillImport,
  skillDelete,
  skillSetEnabled,
  systemEndProcess,
  systemOpenDiskCleanup,
  healthState,
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

  // Quick assistant: nothing to run in a browser, so these answer empty.
  quickAsk: async (prompt: string): Promise<string> => {
    console.info("[mock] quick_ask", prompt);
    return "";
  },
  quickShortcutStatus: async () => ({ shortcut: null, registered: false, error: null }),
  quickShortcutSet: async (shortcut: string | null) => ({ shortcut, registered: shortcut != null, error: null }),
  quickFolders: async (): Promise<string[]> => [],
  quickFolderAdd: async (): Promise<string | null> => null,
  quickFolderRemove: noop("quick_folder_remove"),
  quickApps: async () => [],
  quickAppAdd: async () => null,
  quickAppRemove: noop("quick_app_remove"),
  quickLog: async () => [],
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
