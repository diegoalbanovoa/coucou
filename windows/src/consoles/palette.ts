// Console face colours — see docs/plan-v2.md § 3.2.
//
// Colours only, no logos or trademarks: the same rule `mochi/minibots.ts`
// already follows for the integration pills. The shell entries (pwsh, cmd,
// wsl, gitbash) are defined because the plan's own table lists them, but
// `consoles.rs` only ever reports agent CLIs today — see the "solo CLIs de
// agentes" decision in docs/plan-v2-notas.md — so nothing currently asks
// this module for those colours. They are here so a later decision to add
// shells does not also need a new palette.

export const CONSOLE_PALETTE: Record<string, string> = {
  claude: "#d97757",
  gemini: "#4e8cf7",
  codex: "#10a37f",
  copilot: "#8957e5",
  "cursor-agent": "#a1a1aa",
  qwen: "#615ced",
  opencode: "#f5a524",
  pwsh: "#2f6fd6",
  powershell: "#2f6fd6",
  cmd: "#71717a",
  wsl: "#e95420",
  gitbash: "#f05033",
};

/** The colour tile() tints a console's face with — a fixed grey-on-fill for
 *  anything not in the table above, rather than a crash or a blank. */
export const UNKNOWN_CONSOLE_COLOR = "#8e939c";

export function consoleColor(id: string): string {
  return CONSOLE_PALETTE[id] ?? UNKNOWN_CONSOLE_COLOR;
}
