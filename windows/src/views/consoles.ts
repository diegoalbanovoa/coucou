// The console panel: which agent consoles this machine has, which one the
// chat will run, and which sessions are live right now.
//
// It fills the overview's right card whenever there are no integration pills to
// show there — which, with no integration keys configured, is always. The same
// component is the start screen's body, so there is one list to get right
// rather than two that drift.
//
// A console here is an agent CLI Coucou can drive. Not a shell and not a
// terminal window: PowerShell has no turns to take, and a Windows Terminal tab
// cannot be driven from outside. Live sessions are the other half of the
// picture and need no detection at all — they arrive as hook events, which is
// how the island already knows the terminal and folder each one is in.

import { h, clear } from "./dom";
import { icon } from "./icons";
import type { Console } from "../core/bridge";
import { State } from "../core/state";
import { stillMiniBot } from "../mochi/minibots";
import { availableClis, chooseProvider, reloadConsoles } from "../island/agent";

/** How long after a focus a re-scan is worth doing. */
const RESCAN_AFTER_MS = 5_000;

let lastScan = 0;

/**
 * Looks again for consoles, at most once every few seconds.
 *
 * Installing a CLI should show up without a restart, and the cheapest moment
 * to notice is when the window comes back. The guard is because focus fires
 * every time the island is hovered.
 */
export function rescanOnFocus() {
  const now = Date.now();
  if (now - lastScan < RESCAN_AFTER_MS) return;
  lastScan = now;
  void reloadConsoles();
}

function badge(text: string, kind: "can" | "cannot" | "warn"): HTMLElement {
  return h("span", { class: `cap cap-${kind}`, text });
}

/** What this console can do, as three separate answers. */
function capabilities(c: Console): HTMLElement {
  const row = h("div", { class: "cap-row" });
  row.append(
    c.can.streaming ? badge("streams", "can") : badge("one shot", "cannot"),
    c.can.approvable ? badge("approvable here", "can") : badge("asks in its terminal", "cannot"),
  );
  // Said plainly rather than left for the user to discover: four of the seven
  // are driven the way their own documentation says and have never run here.
  if (!c.verified) row.append(badge("unverified", "warn"));
  return row;
}

/** The sessions running right now, whatever started them. */
function liveSessions(): HTMLElement[] {
  return State.tasks
    .filter((t) => t.source === "claudeCode" && (t.state !== "idle" || t.steps.length > 0))
    .map((t) =>
      h(
        "div",
        { class: "live-row", title: t.sessionCwd ?? "" },
        h("i", { class: "live-dot" }),
        h("span", { class: "live-name", text: t.name }),
        h("span", { class: "live-where", text: t.host ?? "" }),
      ),
    );
}

export function buildConsolePanel(opts: { onPick?: () => void } = {}) {
  const list = h("div", { class: "console-list" });
  const live = h("div", { class: "live-list" });
  const title = h("div", { class: "console-title" });
  const el = h("div", { class: "console-panel" }, title, list, live);

  let rendered = "";
  /** Which row the keyboard is on. -1 until a key is pressed. */
  let cursor = -1;

  function rows(): HTMLElement[] {
    return Array.from(list.querySelectorAll<HTMLElement>(".console-row"));
  }

  function moveCursor(step: number) {
    const all = rows();
    if (all.length === 0) return;
    cursor = cursor < 0 ? 0 : (cursor + step + all.length) % all.length;
    all.forEach((row, i) => row.classList.toggle("cursor", i === cursor));
    all[cursor].scrollIntoView({ block: "nearest" });
  }

  el.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      moveCursor(key === "ArrowDown" ? 1 : -1);
    } else if (key === "Enter" && cursor >= 0) {
      event.preventDefault();
      event.stopPropagation();
      rows()[cursor]?.click();
    }
  });

  return {
    el,
    sync() {
      const sessions = liveSessions();
      const shape = [
        availableClis.map((c) => `${c.id}:${c.version}`).join("|"),
        State.agentCli,
        sessions.length,
        State.tasks.map((t) => `${t.id}:${t.name}:${t.host ?? ""}:${t.state}`).join("|"),
      ].join("~");
      if (shape === rendered) return;
      rendered = shape;

      title.textContent =
        availableClis.length > 0
          ? `${availableClis.length} console${availableClis.length === 1 ? "" : "s"}`
          : "No agent console found";

      clear(list);
      if (availableClis.length === 0) {
        list.append(
          h("div", {
            class: "console-empty",
            text: "Coucou looks on PATH and where npm, nvm, Volta, Bun, pnpm and the vendors' own installers put things.",
          }),
        );
      }

      for (const console of availableClis) {
        const on = console.id === State.agentCli;
        const row = h(
          "button",
          { class: on ? "console-row on" : "console-row", title: console.path },
          h("span", { class: "console-face" }, stillMiniBot(console.color, 20)),
          h(
            "span",
            { class: "console-text" },
            h(
              "span",
              { class: "console-head" },
              h("b", { text: console.label }),
              h("span", { class: "console-version", text: console.version }),
            ),
            capabilities(console),
          ),
          on ? icon("check", { size: 11 }) : h("span", { class: "console-pick" }),
        );
        row.addEventListener("click", () => {
          chooseProvider(console.id);
          opts.onPick?.();
        });
        list.append(row);
      }

      clear(live);
      if (sessions.length > 0) {
        live.append(h("div", { class: "live-title", text: "running now" }), ...sessions);
      }
    },
    /** Called when the panel becomes visible. */
    focus() {
      rescanOnFocus();
      el.focus();
    },
  };
}
