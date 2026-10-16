// Entry point: boot the bridge, wire the island, start the greeting.
// Loaded by index.html for the island window (the settings window has its own
// entry, settings/main.ts).

import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { Island } from "./island/island";
import { loadAgentEnvironment, registerAgentHandlers } from "./island/agent";
import { rescanOnFocus } from "./views/consoles";
import { resetQuickAsk } from "./views/quick";
import { registerHookHandlers } from "./island/hooks";
import { startRoutineScheduler } from "./island/routines";
import { registerHealthHandlers } from "./island/health";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";
import { setLocale, getLocale, resolveLocale } from "./i18n/index";

// Nothing else here can see a crash — there is no visible console in a
// release build, and a silent exception mid-boot can take the rest of
// `main()` down with it (whatever runs after the line that threw never
// does). Logged to coucou.log, the one place a report of "it's not doing
// anything" can be checked against after the fact.
window.addEventListener("error", (e) => {
  void Bridge.log(`[uncaught] ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  void Bridge.log(`[unhandled rejection] ${String(e.reason)}`);
});

/**
 * Boot sequence: preload sounds, create the island, fetch boot data and
 * settings from Rust, subscribe to backend events (cursor, tray, shortcut,
 * screen and settings changes), register the island handlers, then launch.
 * Order matters: handlers are registered before `island.launch()` so no early
 * event is lost.
 */
async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  // Boot data first, locale next, island last: the views read `t()` while they
  // are built, so building them before `setLocale()` froze them in English.
  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
    State.workAreaHeight = boot.screen.workHeight;
  }
  setLocale(resolveLocale(State.settings.language));
  document.documentElement.lang = resolveLocale(State.settings.language);

  const island = new Island(root);
  island.applySettings();
  State.loadIntegrationTasks();
  if (boot && !boot.cursorPoll) island.followPageCursor();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    void Bridge.setPaused(on);
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        island.alert("settings");
        break;
      case "open":
        setPaused(false);
        island.alert(State.defaultView());
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  // The global shortcut. Paused means paused, like a file drag: nothing opens.
  // Always a blank input, and kept open (pinned) while the user types.
  await onEvent<null>("quick-ask", () => {
    if (State.paused) return;
    resetQuickAsk();
    State.isPinned = true;
    island.alert("quick");
  });

  await onEvent<null>("screen-changed", () => {
    void Bridge.reposition();
    void Bridge.screenInfo().then((info) => {
      if (!info) return;
      State.workAreaHeight = info.workHeight;
      island.refreshGeometry();
    });
  });

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    const before = getLocale();
    setLocale(resolveLocale(State.settings.language));
    document.documentElement.lang = resolveLocale(State.settings.language);
    if (getLocale() !== before) island.rebuildViews();
    island.applySettings();
    State.loadIntegrationTasks();
    void refreshConfigured();
  });

  registerHookHandlers(island);
  // New this session (plan-v2.md § 7) — wrapped so that if it ever throws,
  // it costs Mochi's mood and nothing else. Everything after it (the rest of
  // boot, island.launch()) must run whether or not this does.
  try {
    registerHealthHandlers(island);
  } catch (err) {
    console.error("[health] registerHealthHandlers failed:", err);
  }
  registerIntegrationHandlers(island);

  registerAgentHandlers(island);

  // Which CLIs exist and what `/` can reach. Not awaited: the island should
  // come up at once, and the chat header fills in a moment later.
  void loadAgentEnvironment();

  // Installing a CLI should show up without a restart, and the cheapest moment
  // to notice is when the window comes back. `rescanOnFocus` throttles it,
  // because focus fires every time the island is hovered.
  window.addEventListener("focus", () => rescanOnFocus());

  island.launch();

  // Routines (plan v4, Fase 7): the webview schedules, Rust runs. No timer at
  // all while no routine is switched on.
  startRoutineScheduler(island);
  // Mock mode only: `?view=digest` (or `digest-error`) opens the digest view.
  if (!IS_TAURI && /^digest/.test(new URLSearchParams(location.search).get("view") ?? "")) {
    window.setTimeout(() => island.alert("digest"), 7500);
  }

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
