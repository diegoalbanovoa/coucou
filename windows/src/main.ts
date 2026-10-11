// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { Island } from "./island/island";
import { loadAgentEnvironment, registerAgentHandlers } from "./island/agent";
import { rescanOnFocus } from "./views/consoles";
import { registerHookHandlers } from "./island/hooks";
import { registerHealthHandlers } from "./island/health";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";
import { setLocale, resolveLocale } from "./i18n/index";

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

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
    State.workAreaHeight = boot.screen.workHeight;
  }
  setLocale(resolveLocale(State.settings.language));
  document.documentElement.lang = resolveLocale(State.settings.language);
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
    setLocale(resolveLocale(State.settings.language));
    document.documentElement.lang = resolveLocale(State.settings.language);
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

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
