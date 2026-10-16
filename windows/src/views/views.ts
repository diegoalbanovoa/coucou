// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.
// `buildViews` is the registry the island uses to create every view once and
// switch between them; each view is a `ViewHost`.

import { h, clear, dot } from "./dom";
import { icon } from "./icons";
import { Ticker } from "./ticker";
import { State, type AgentTask } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { buildPrompt } from "./chat";
import { buildHomeRightCard } from "./consoles";
import { buildSystem } from "./system";
import { buildQuick } from "./quick";
import { buildDigest } from "./digest";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import { t, getLocale } from "../i18n/index";
import { healthTooltip } from "../island/health";

/** What views may ask the island to do; implemented by island.ts. */
export interface ViewActions {
  setView(v: IslandViewName): void;
  /** Closes the expanded island. */
  collapse(): void;
  /** Focuses the pill/task with this id. */
  setFocus(id: string): void;
  /** Brings the user's terminal to the front. */
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  /** Answers the pending permission request. */
  decide(d: "allow" | "deny"): void;
  toggleSound(): void;
  setVolume(v: number): void;
  /** Sets how long the island stays open after the last interaction. */
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  /** Plays the UI click sound. */
  blip(): void;
}

/** The contract every island view implements; only `el` and `sync` are mandatory. */
export interface ViewHost {
  /** Root element, created once and reused. */
  el: HTMLElement;
  /** Brings the DOM in line with `State`; called on every state notification, so keep it cheap. */
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
  /**
   * Whether this view still needs frames. The island's loop stops as soon as
   * nothing is moving, so a view with an animation of its own has to say so or
   * it freezes part-way through.
   */
  animating?(): boolean;
  /**
   * Called when this view stops being the one on screen. A view that started
   * anything — a timer, a subscription — stops it here, which is what keeps a
   * tab nobody has open from costing anything.
   */
  blur?(): void;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

/** A rounded card, optionally tinted with a colour wash (approval = amber, error = red...). */
function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

/** Pill button with an optional keyboard-shortcut hint. */
function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  // "Claude Code Claude Code" when the pill is named after the agent itself.
  if (task?.name !== label) row.append(h("span", { text: label }));
  return row;
}

/** Padded column used inside cards; the left padding clears Mochi's face. */
function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

/**
 * The island's top bar: Home / Chat / System tabs (with a health badge on
 * System) and the settings and sound buttons. Hidden while Mochi is dizzy.
 */
export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", onclick: () => go("overview") }, icon("house", { size: 13 }));
  const tabChat = h("button", { class: "tab", onclick: () => go("prompt") }, icon("bubble", { size: 13 }));
  const healthBadge = h("i", { class: "tab-health-badge" });
  const tabSystem = h(
    "button",
    { class: "tab", onclick: () => go("system") },
    icon("disk", { size: 13 }),
    healthBadge,
  );

  const gearBtn = h("button", { onclick: () => go("settings") }, icon("gear", { size: 14 }));
  const soundBtn = h("button", { onclick: () => actions.toggleSound() }, icon("speakerOn", { size: 14 }));

  /** Switches view with a click sound. */
  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabSystem),
    h("div", { class: "header-actions" }, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabSystem.classList.toggle("on", v === "system");
      const health = State.health;
      const healthLevel = health?.level ?? "ok";
      healthBadge.classList.toggle("show", healthLevel !== "ok");
      healthBadge.classList.toggle("sick", healthLevel === "sick");
      // Colour is never the only signal this carries — a Narrador user (or
      // anyone hovering before the tab is even open) gets the same words
      // the tooltip over Mochi itself says once inside the tab.
      if (health && healthLevel !== "ok") {
        const label = healthTooltip(health);
        healthBadge.setAttribute("aria-label", label);
        healthBadge.title = label;
      } else {
        healthBadge.removeAttribute("aria-label");
        healthBadge.title = "";
      }
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(icon("gear", { size: 14 }));
      clear(soundBtn);
      soundBtn.append(icon(State.settings.soundEnabled ? "speakerOn" : "speakerOff", { size: 14 }));
      el.style.opacity = v === "confused" ? "0" : "1";

      tabHome.title = t("tabs.home");
      tabChat.title = t("tabs.chat");
      tabSystem.title = t("tabs.system");
      gearBtn.title = t("tabs.settings");
      soundBtn.title = t("tabs.mute");
    },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

/**
 * Home view: left card shows the ticker for a live Claude Code session or the
 * focused integration's card; right card is the consoles/services pane.
 */
function buildOverview(actions: ViewActions): ViewHost {
  const ticker = new Ticker();
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", onclick: () => actions.openTarget() },
    icon("arrowUpRight", { size: 8 }),
  );
  const left = card(null, leftBody, jump);
  // One card, two panes behind a segmented switch (Fase 3) — a user's
  // choice via settings.homeRightPane, not the old "pills if any are
  // configured, else consoles" auto-detection that left consoles
  // unreachable the moment someone configured an integration.
  const homeCard = buildHomeRightCard({ setFocus: (id) => actions.setFocus(id) });
  const right = card(null, homeCard.el);

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, right),
  );

  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | null = null;
  let cardKey = "";

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  return {
    el,
    tick(nowMs: number) {
      if (mode === "ticker") ticker.tick(nowMs);
    },
    animating() {
      return mode === "ticker" && ticker.animating;
    },
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        cardKey = "";
        mode = null;
      }

      // VS Code with a live Claude Code session keeps the ticker; every other
      // pill shows its own card, exactly like IntegrationCardView.
      const sessionActive =
        task?.id === "integration_claude" && (task.state !== "idle" || task.steps.length > 0);

      if (task && sessionActive) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        clear(who);
        const agent = task.source === "claudeCode" ? "Claude Code" : "n8n";
        const tool = task.host ? `${agent} · ${task.host}` : agent;
        who.append(
          dot(task.color, 7),
          h("span", { class: "name", text: task.name }),
          // The agent, and where it runs when that is known: "Claude Code ·
          // Windows Terminal" rather than a flat "VS Code". Left out when it
          // would only repeat the pill's own name.
          ...(tool !== task.name ? [h("span", { class: "tool", text: tool })] : []),
        );
        if (task.steps.length > 1) {
          who.append(h("span", {
            class: "count",
            text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
          }));
        }
        ticker.sync(task);
      } else if (task) {
        const info = State.integrations[task.id];
        const key = [
          task.id, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}), getLocale(),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        }
      }

      // Claude Code has nowhere real to jump to — its own ↗ used to open
      // VS Code as the closest thing, which read as a bug to click into
      // ("why does this open an editor") rather than a feature. Hidden for
      // it specifically; "Open Visual Studio Code" is still reachable from
      // its own card (renderIntegrationCard) for whoever wants it.
      jump.style.display = detailOpen || task?.id === "integration_claude" ? "none" : "";
      jump.title = t("tabs.openTarget");

      homeCard.sync();
    },
  };
}

// ── Empty ─────────────────────────────────────────────────────────────────────

/**
 * The start screen: the agent CLIs found on this machine.
 *
 * What used to be here was "Nothing running right now" and a button. The
 * agents are the useful thing to show — which ones this machine has, which one
 * the chat will run, and where each was found.
 */
/**
 * The start screen: the consoles this machine has.
 *
 * The same panel the overview's right card shows, so there is one list to get
 * right instead of two that drift apart. Picking one here goes straight to the
 * chat, which is what someone on this screen was reaching for.
 */
function buildEmpty(actions: ViewActions): ViewHost {
  const panel = buildHomeRightCard({
    setFocus: (id) => actions.setFocus(id),
    onPick: () => actions.setView("prompt"),
  });
  const body = h("div", { class: "stack", style: "padding:0 16px 0 104px" }, panel.el);
  return {
    el: h("div", { class: "view" }, card(null, body)),
    sync: () => panel.sync(),
    focus: () => panel.focus(),
  };
}

// ── Approval ──────────────────────────────────────────────────────────────────

/** Permission request: shows the command or tool being authorised with Deny/Allow buttons. */
function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("amber", stack(116, 16, who, code, row)));
  // Rebuilt once per locale rather than every sync: rebuilding between a
  // mouse-down and a mouse-up would swallow the click, and nothing else about
  // these two buttons ever changes — except their words, when the language
  // does, which is rare enough never to land mid-click in practice.
  let builtFor = "";
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, t("overview.needsPermission")));
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      if (builtFor === getLocale()) return;
      builtFor = getLocale();
      clear(row);
      row.append(
        btn(t("overview.deny"), "secondary", () => actions.decide("deny"), "N"),
        btn(t("overview.allow"), "primary", () => actions.decide("allow"), "Y"),
      );
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

/** The agent asked a question; answering happens in the terminal. */
function buildQuestion(): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, t("overview.askingQuestion")));
      const task = State.focusTask;
      title.textContent = task?.steps.at(-1) ?? t("overview.claudeNeedsAnswer");
      clear(row);
      row.append(h("div", { class: "sub", text: t("overview.answerInTerminal") }));
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

/** Session/workflow stopped on error, with the last step as detail. */
function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  let builtFor = "";
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      who.append(agentWho(task, task?.source === "n8n" ? "n8n" : "Claude Code"));
      title.textContent = task?.source === "n8n" ? t("overview.workflowStopped") : t("overview.sessionStoppedOnError");
      detail.textContent = task?.steps.at(-1) ?? t("overview.noDetail");
      // See buildApproval's note: rebuilt once per locale, not every sync.
      if (builtFor === getLocale()) return;
      builtFor = getLocale();
      clear(row);
      row.append(
        btn(t("overview.retry"), "primary", () => actions.setView(State.defaultView())),
        btn(t("overview.openInN8n"), "secondary", () => actions.openUrl("")),
      );
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

/** Session finished; offers to open the terminal or dismiss. */
function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  let builtFor = "";
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, t("overview.claudeCodeFinished")));
      title.textContent = State.focusTask?.steps.at(-1) ?? t("overview.sessionFinished");
      // See buildApproval's note: rebuilt once per locale, not every sync.
      if (builtFor === getLocale()) return;
      builtFor = getLocale();
      clear(row);
      row.append(
        btn(t("overview.openTerminal"), "primary", () => actions.openTerminal()),
        btn(t("overview.ok"), "secondary", () => actions.collapse()),
      );
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

/** Shown after Mochi is slapped three times (dizzy). */
function buildConfused(): ViewHost {
  const title = h("div", { class: "title" });
  const sub = h("div", { class: "sub" });
  const body = h("div", { class: "stack", style: "padding:0 18px 0 128px" }, title, sub);
  return {
    el: h("div", { class: "view" }, card("pink", body)),
    sync() {
      title.textContent = t("overview.tooManyHits");
      sub.textContent = t("overview.backToWork");
    },
  };
}

// ── Note ──────────────────────────────────────────────────────────────────────

/** Shows `State.noteMessage` as a one-line notice. */
function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

/** Quick in-island settings: sound, volume, auto-close and connection badges. */
function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );
  const claudeBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });
  const soundLabel = h("span", {});
  const settingsLink = h("button", {
    class: "link-btn",
    style: "color:#8e939c;font-size:11.5px",
    onclick: () => actions.openSettingsWindow(),
  });

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, soundLabel, volume),
    h(
      "div",
      { class: "settings-row" },
      icon("timer", { size: 12 }),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      claudeBadge,
      apiBadge,
      h("div", { class: "grow" }),
      settingsLink,
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      soundLabel.textContent = t("settings.general.sound");
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = `${t("settings.general.autoClose")} · ${Math.round(s.autoCloseInterval)}s`;
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
      settingsLink.textContent = t("integrations.settingsLink");
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Claude Code" }),
      );
      clear(apiBadge);
      apiBadge.append(dot("#F4505E", 6), h("span", { text: "API" }));
    },
  };
}

// ── Placeholders filled in later stages ───────────────────────────────────────

/** Stub view for features not available on Windows yet; takes i18n keys for its text. */
function buildPlaceholder(titleKey: Parameters<typeof t>[0], subKey?: Parameters<typeof t>[0]): ViewHost {
  const title = h("div", { class: "title" });
  const sub = h("div", { class: "sub" });
  const body = h("div", { class: "stack", style: "padding:0 18px 0 118px" }, title, sub);
  return {
    el: h("div", { class: "view" }, card(null, body)),
    sync() {
      title.textContent = t(titleKey);
      sub.textContent = subKey ? t(subKey) : "";
    },
  };
}

// ── Registry ──────────────────────────────────────────────────────────────────

/**
 * Creates every view once, keyed by name. `onChatHeightChange` lets the chat
 * ask the island to resize as its content grows.
 */
export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion());
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("prompt", buildPrompt(onChatHeightChange));
  map.set("system", buildSystem());
  map.set("quick", buildQuick(actions));
  map.set("digest", buildDigest(actions));
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set("mail", buildPlaceholder("overview.sendingByEmail"));
  map.set("searching", buildPlaceholder("overview.searching"));
  map.set("result", buildPlaceholder("overview.result"));
  return map;
}
