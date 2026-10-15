// Fixture consoles for mock mode (see plan-v2.md § 0.2).
//
// Shaped like `Console` from `core/bridge.ts`, but typed locally rather than
// imported from there — importing "../core/bridge" from anything under
// `src/dev/` would hit the same mock-mode alias this file exists to feed,
// which is a trap worth never setting.
//
// Claude Code is verified; `mock-bridge.ts` feeds the first entry of
// `MOCK_LIVE_SESSIONS` below into the one Claude Code task the current data
// model keeps (see the note on that in `docs/plan-v2-notas.md` — showing two
// sessions at once needs a Fase 3 data-model change, not invented here).
// Gemini and Copilot are the installed-but-unverified ones Coucou is honest
// about; PowerShell previews the shell-detection Fase 3 is deciding on —
// mock-only, not a claim that shells are in scope.

/** Local copy of `Console` from core/bridge.ts. */
export interface MockConsole {
  id: string;
  label: string;
  path: string;
  version: string;
  color: string;
  can: { streaming: boolean; resume: boolean; approvable: boolean };
  verified: boolean;
  configPath: string;
}

/** Consoles the mock `agentClis` reports: one verified, one partial, two unverified. */
export const MOCK_CONSOLES: MockConsole[] = [
  {
    id: "claude",
    label: "Claude Code",
    path: "C:\\Users\\diego\\.local\\bin\\claude.exe",
    version: "2.1.241 (Claude Code)",
    color: "#d97757",
    can: { streaming: true, resume: true, approvable: true },
    verified: true,
    configPath: "C:\\Users\\diego\\AppData\\Roaming\\Coucou\\agents\\claude.json",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    path: "C:\\Users\\diego\\AppData\\Roaming\\npm\\gemini.cmd",
    version: "0.4.2",
    color: "#4e8cf7",
    can: { streaming: false, resume: false, approvable: false },
    verified: true,
    configPath: "C:\\Users\\diego\\AppData\\Roaming\\Coucou\\agents\\gemini.json",
  },
  {
    id: "copilot",
    label: "Copilot CLI",
    path: "C:\\Users\\diego\\AppData\\Local\\GitHubCopilotCLI\\copilot.exe",
    version: "1.2.0",
    color: "#8957e5",
    can: { streaming: false, resume: false, approvable: false },
    verified: false,
    configPath: "C:\\Users\\diego\\AppData\\Roaming\\Coucou\\agents\\copilot.json",
  },
  {
    id: "pwsh",
    label: "PowerShell",
    path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    version: "7.4.6",
    color: "#2f6fd6",
    can: { streaming: false, resume: false, approvable: false },
    verified: false,
    configPath: "C:\\Users\\diego\\AppData\\Roaming\\Coucou\\agents\\pwsh.json",
  },
];

/** Live sessions for the console detail / "running now" list — see hooks.ts. */
export const MOCK_LIVE_SESSIONS = [
  { id: "mock-session-coucou", name: "coucou", cwd: "C:\\Users\\diego\\IdeaProjects\\coucou", host: "Windows Terminal" },
  { id: "mock-session-api", name: "api-pagos", cwd: "C:\\Users\\diego\\IdeaProjects\\api-pagos", host: "Windows Terminal" },
];
