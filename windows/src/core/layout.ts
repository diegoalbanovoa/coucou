/**
 * Island geometry — ported from IslandTypes.swift + IslandWindowController.islandSize
 * + IslandRootView.botPosition. All values are logical pixels, identical to the
 * macOS app's points.
 *
 * Pure data and functions, no DOM: island/island.ts uses them to size the
 * island and place Mochi, views read `VIEW_LAYOUTS`, and state.ts takes the
 * shared name types from here. PANEL_W/PANEL_H must match island.rs on the
 * Rust side.
 */

/** Collapse level: retracted to nothing, the compact pill, or the full card. */
export type IslandMode = "hidden" | "compact" | "expanded";

/** Every screen the expanded island can show; keys of `VIEW_LAYOUTS`. */
export type IslandViewName =
  | "overview"
  | "empty"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "confused"
  | "mail"
  | "prompt"
  | "searching"
  | "result"
  | "note"
  | "settings"
  | "system"
  | "greeting"
  | "quick"
  | "digest";

/** Mochi's activity states (mirror of the Mac BotState); drive animation and glow. */
export type BotStateName =
  | "idle"
  | "working"
  | "thinking"
  | "searching"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "ratelimit"
  | "sleeping"
  | "dizzy";

/** Short one-shot expressions Mochi can play over its current state. */
export type BotEmoteName = "love" | "surprised" | "proud" | "wink" | "yawn" | "happy" | "annoyed";

/** How the other agents' pills are arranged beside the main card. */
export type AgentLayoutMode = "none" | "grid" | "pills" | "column";

/** Per-view geometry of the expanded island. */
export interface ViewLayout {
  /** Card height before clamping to the work area. */
  height: number;
  /** Mochi's centre, x from the island's left edge. */
  botX: number;
  botY: number | null; // null = auto-centred
  /** 0 to 1 effectively hides Mochi for views that draw their own. */
  botDiameter: number;
  agentMode: AgentLayoutMode;
}

// The window is a fixed 720×640 (tall enough for the tallest view) like the
// macOS panel; the island is drawn inside it, glued to the top edge and
// horizontally centred. PANEL_H has to stay ≥ CHAT_MAX_H + its margin or the
// window itself clips the expanded chat — see chatPromptHeight's note and
// src-tauri/src/island.rs's PANEL_H, hand-kept equal to this one.
export const PANEL_W = 720;
export const PANEL_H = 640;

// No notch on a PC: these are the hidden/compact sizes from docs/SPEC.md.
export const NOTCH_W = 184;
export const NOTCH_H = 32;
export const COMPACT_W = 288; // NOTCH_W + 104
export const EXPANDED_W = 640;

export const ROUNDED_CORNER = 14; // hidden / compact
export const EXPANDED_CORNER = 22;

/** Invisible hover strip that wakes the island when hidden. */
export const WAKE_STRIP_W = 240;
export const WAKE_STRIP_H = 6;

/** Layout of every view; add an entry here when adding an `IslandViewName`. */
export const VIEW_LAYOUTS: Record<IslandViewName, ViewLayout> = {
  // Fase 6 (plan-v2.md § 6.2): Mochi is the protagonist of this view, large
  // and centred in its own left column rather than sharing the header strip
  // the other views tuck it into — hence the explicit `botY` rather than the
  // generic "centre of an 84pt card" fallback `botPosition` falls back to
  // when it is null, which assumes a card far shorter than this one.
  system: { height: 380, botX: 70, botY: 211, botDiameter: 96, agentMode: "none" },
  overview: { height: 160, botX: 68, botY: null, botDiameter: 58, agentMode: "pills" },
  empty: { height: 160, botX: 70, botY: null, botDiameter: 62, agentMode: "none" },
  approval: { height: 160, botX: 62, botY: null, botDiameter: 56, agentMode: "column" },
  question: { height: 160, botX: 62, botY: null, botDiameter: 56, agentMode: "column" },
  error: { height: 160, botX: 62, botY: null, botDiameter: 58, agentMode: "column" },
  finished: { height: 160, botX: 62, botY: null, botDiameter: 58, agentMode: "column" },
  confused: { height: 160, botX: 76, botY: null, botDiameter: 66, agentMode: "column" },
  mail: { height: 240, botX: 56, botY: null, botDiameter: 46, agentMode: "column" },
  // The chat draws its own small Mochi in its header (24px, same engine —
  // see views/chat.ts's avatarSlot) instead of using the big shared one
  // every other view places off to the side. Tucked into the corner at
  // effectively zero size rather than actually skipped: botPosition() has no
  // per-view "don't draw" branch, and one was not worth adding for this.
  prompt: { height: 160, botX: 8, botY: 8, botDiameter: 1, agentMode: "none" },
  searching: { height: 160, botX: 52, botY: null, botDiameter: 44, agentMode: "column" },
  result: { height: 160, botX: 52, botY: null, botDiameter: 44, agentMode: "column" },
  note: { height: 160, botX: 60, botY: null, botDiameter: 50, agentMode: "column" },
  settings: { height: 160, botX: 54, botY: null, botDiameter: 46, agentMode: "none" },
  // The quick-ask input: no Mochi of its own, like the chat — see views/quick.ts.
  quick: { height: 200, botX: 8, botY: 8, botDiameter: 1, agentMode: "none" },
  // A routine's result (views/digest.ts): no Mochi of its own, like quick.
  digest: { height: 320, botX: 8, botY: 8, botDiameter: 1, agentMode: "none" },
  greeting: { height: 150, botX: 320, botY: 90, botDiameter: 0, agentMode: "none" },
};

/** The chat never gets less than this, whatever is in it. */
export const CHAT_MIN_H = 300;
/** Nor more than this share of the work area it is on… */
const CHAT_SCREEN_SHARE = 0.62;
/** …nor more than this outright, however large the display. */
export const CHAT_MAX_H = 620;
/** Room the attachment tray (56px tiles, plan-v2.md § 5.5) needs on top of
 *  the log when it has anything in it — the tile height plus the gap above
 *  and below it (style.css's .chat-body `gap` and the tray's own margin).
 *  Without this the tray was sized for the old, shorter image chips
 *  (Fase 4) and the new taller tiles clipped against the composer. */
const ATTACHMENT_TRAY_H = 70;

/** `desired`, pinned inside `[minHeight, maxHeight]`. Applied to every view's
 *  height (not just the chat's) so none of them can ever ask the native
 *  window — fixed at `PANEL_H`, which only covers up to `CHAT_MAX_H` — for
 *  more than the display the island is on can actually show before the
 *  window itself clips it. See docs/plan-v2-notas.md § Fase 4. */
export function clampViewHeight(desired: number, maxHeight: number, minHeight: number): number {
  return Math.min(Math.max(desired, minHeight), maxHeight);
}

/**
 * How tall the chat panel is.
 *
 * This used to be `Math.min(300, 240 + count * 40)`: it grew to 300 px and
 * stopped there, on every display, whatever the conversation. Inside those
 * 300 px live a header, a chip row, the message log, the `/` palette and the
 * composer — which is why there was nowhere to put a search bar, and why the
 * log was a few lines tall on a 4K screen.
 *
 * The ceiling comes from the display rather than a constant. `workAreaHeight`
 * is `core/bridge.ts`'s `ScreenInfo.workHeight` — the real work area of the
 * monitor the island is on (taskbar excluded), read from Rust's
 * `MonitorFromWindow`/`GetMonitorInfoW` rather than guessed from
 * `window.screen`, which can name the wrong monitor entirely when the island
 * is not on the primary display. `CHAT_MAX_H` is still there because a chat
 * taller than that stops being an island and becomes a window.
 */
export function chatPromptHeight(
  messageCount: number,
  expanded = false,
  workAreaHeight = 1080,
  hasAttachments = false,
): number {
  const ceiling = clampViewHeight(Math.round(workAreaHeight * CHAT_SCREEN_SHARE), CHAT_MAX_H, CHAT_MIN_H);
  if (expanded) return ceiling;
  const desired = 300 + messageCount * 44 + (hasAttachments ? ATTACHMENT_TRAY_H : 0);
  return clampViewHeight(desired, ceiling, CHAT_MIN_H);
}

/**
 * Island size in logical px for a mode and view. Hidden is zero-height, compact
 * is a fixed pill, expanded uses the view's height (the chat's is dynamic)
 * clamped to the work area so the fixed-size native window never clips it.
 */
export function islandSize(
  mode: IslandMode,
  view: IslandViewName,
  chatCount = 0,
  chatExpanded = false,
  workAreaHeight = 1080,
  chatHasAttachments = false,
): { w: number; h: number } {
  switch (mode) {
    case "hidden":
      // No notch to hide inside on a PC: the island retracts to zero height and
      // slides into the top edge of the screen instead of sitting there as a bar.
      return { w: NOTCH_W, h: 0 };
    case "compact":
      return { w: COMPACT_W, h: NOTCH_H };
    case "expanded": {
      const h =
        view === "prompt"
          ? chatPromptHeight(chatCount, chatExpanded, workAreaHeight, chatHasAttachments)
          : clampViewHeight(VIEW_LAYOUTS[view].height, workAreaHeight, 0);
      return { w: EXPANDED_W, h };
    }
  }
}

/** Where and how big to draw Mochi, relative to the island's top-left. */
export interface BotPlacement {
  cx: number;
  cy: number;
  diameter: number;
  opacity: number;
}

/** IslandRootView.botPosition — cy is measured from the island's top edge. */
export function botPosition(mode: IslandMode, view: IslandViewName, islandH: number): BotPlacement {
  switch (mode) {
    case "hidden":
      return { cx: 46, cy: 16, diameter: 6, opacity: 0 };
    case "compact":
      return { cx: 40, cy: 16, diameter: 20, opacity: 1 };
    case "expanded": {
      const layout = VIEW_LAYOUTS[view];
      if (layout.botY != null) {
        return { cx: layout.botX, cy: layout.botY, diameter: layout.botDiameter, opacity: 1 };
      }
      // Centre of the fixed 84 pt card (8 pt top inset + 34 pt header → content at y = 42)
      const headerBottom = 42;
      const cardH = 84;
      const cy = headerBottom + (islandH - headerBottom - cardH) / 2 + cardH / 2;
      return { cx: layout.botX, cy, diameter: layout.botDiameter, opacity: 1 };
    }
  }
}

/** Glow colour behind Mochi for a state; white for the calm states. */
export function botGlowColor(s: BotStateName): string {
  switch (s) {
    case "working":
      return "#3B9EFF";
    case "thinking":
      return "#A78BFA";
    case "searching":
      return "#6366F1";
    case "approval":
      return "#F5A524";
    case "error":
      return "#F4505E";
    case "finished":
      return "#34D399";
    case "ratelimit":
      return "#F59E0B";
    default:
      return "#FFFFFF";
  }
}

/** Glow strength (0 to 1) for a state: faint when resting, none when dizzy. */
export function botGlowOpacity(s: BotStateName): number {
  switch (s) {
    case "idle":
    case "sleeping":
      return 0.15;
    case "dizzy":
      return 0;
    default:
      return 0.65;
  }
}

// Project colours (IslandConst.projectColors)
const PROJECT_COLORS: Record<string, string> = {
  korus: "#FF5A4E",
  "sbe hub": "#2EC4A0",
  "morning ai brief": "#F29B38",
  "publication ig": "#7C5CFF",
  "ig post": "#7C5CFF",
  "louisraille.fr": "#38BDF8",
  louisraille: "#38BDF8",
  "notch buddy": "#EC4899",
  "notch-buddy": "#EC4899",
  notchbuddy: "#EC4899",
};

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

/**
 * Accent colour for a project name: exact match, then substring match against
 * the known projects, else a stable pick from a fallback palette via a string
 * hash (so the same name always gets the same colour).
 */
export function colorForProject(name: string): string {
  const key = name.toLowerCase().trim();
  const exact = PROJECT_COLORS[key];
  if (exact) return exact;
  for (const [k, c] of Object.entries(PROJECT_COLORS)) {
    if (key.startsWith(k) || key.includes(k)) return c;
  }
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

// Card wash colours (CardBackground.washColor)
export type Wash = "red" | "green" | "pink" | "amber" | "cyan" | "indigo" | "soft" | null;

/** CSS `rgba()` for a card wash tint; `null` is fully transparent. */
export function washRGBA(wash: Wash): string {
  switch (wash) {
    case "red":
      return "rgba(244,80,94,0.55)";
    case "green":
      return "rgba(52,211,153,0.5)";
    case "pink":
      return "rgba(244,114,182,0.55)";
    case "amber":
      return "rgba(245,165,36,0.42)";
    case "cyan":
      return "rgba(34,211,238,0.38)";
    case "indigo":
      return "rgba(99,102,241,0.5)";
    case "soft":
      return "rgba(255,255,255,0.08)";
    default:
      return "rgba(0,0,0,0)";
  }
}
