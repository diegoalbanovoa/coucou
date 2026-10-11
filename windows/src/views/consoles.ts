// The overview's right card: two pages in one — consoles and services —
// behind a segmented switch, each shown as a grid of fichas built from the
// same `tile()` component. See docs/plan-v2.md § 3.3, § 3.4 and § 3.5.
//
// Replaces the old "3 CONSOLES" list view and the separate pills/consoles
// toggle `views.ts` used to drive by "does this task have pills configured".
// That toggle is now a user choice (`settings.homeRightPane`), not an
// auto-detection — someone who configures integrations should still be able
// to look at their consoles without unconfiguring them first.

import { h, clear } from "./dom";
import type { Console } from "../core/bridge";
import { Bridge } from "../core/bridge";
import { State, type AgentTask } from "../core/state";
import { stillMiniBot, createMiniBot, pruneMiniBots } from "../mochi/minibots";
import { availableClis, chooseProvider, reloadConsoles } from "../island/agent";
import { t, tn, getLocale } from "../i18n/index";
import { tile } from "../ui/tile";
import { segmented } from "../ui/segmented";
import { iconButton } from "../ui/icon-button";
import { button } from "../ui/button";
import { toast } from "../ui/toast";
import { pushNav } from "../ui/push-nav";
import { orderConsoles, pages, selectedConsoleMissing, tileStateFor } from "../consoles/order";
import { consoleColor } from "../consoles/palette";

const PER_PAGE = 4;
/** How long after a focus a re-scan is worth doing. */
const RESCAN_AFTER_MS = 5_000;
/** How long a press has to hold before it counts as "hold to open detail". */
const HOLD_MS = 500;

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

/** The sessions running right now, as rows inside the detail push-nav. */
function liveSessionRows(): HTMLElement[] {
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

/** A service pill — the same ficha the overview used to build inline, now
 *  owned here so both panes of this card go through one `tile()` call site. */
function servicePill(task: AgentTask, setFocus: (id: string) => void): HTMLElement {
  const el = tile({
    face: createMiniBot(task, 24),
    name: task.name,
    color: task.color,
    badge: task.pillBadge,
    onSelect: () => setFocus(task.id),
  });
  // `tile()` itself is a plain, unfocusable `<div onclick>` — the console
  // grid's own tiles only become reachable by Tab because
  // `attachHoldAndDetail` happens to set `tabIndex`, which service pills
  // never called. Theirs is simpler: no hold-to-open-detail, no right-click,
  // just "this pill is a button" — Enter/Space activates it like one.
  el.tabIndex = 0;
  el.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter" || ke.key === " ") {
      e.preventDefault();
      setFocus(task.id);
    }
  });
  return el;
}

export interface HomeCardOptions {
  setFocus: (id: string) => void;
  onPick?: () => void;
}

export function buildHomeRightCard(opts: HomeCardOptions) {
  let pane: "consoles" | "services" = State.settings.homeRightPane;
  let consolePage = 0;
  /** Set while a detail frame is open, so sync() does not fight the push-nav
   *  over what the card shows. */
  let detailId: string | null = null;

  const dots = h("div", { class: "page-dots" });
  const rescanBtn = iconButton({ icon: "refresh", label: t("consoles.rescan"), onClick: () => void rescan() });

  const seg = segmented<"consoles" | "services">({
    items: [
      { value: "consoles", label: t("home.pane.consoles") },
      { value: "services", label: t("home.pane.services") },
    ],
    value: pane,
    size: "sm",
    onChange: (value) => {
      pane = value;
      consolePage = 0;
      State.settings.homeRightPane = value;
      void Bridge.saveSettings(State.settings);
      draw();
    },
  });

  const head = h("div", { class: "home-card-head" }, seg.el, h("div", { class: "grow" }), dots, rescanBtn);
  const grid = h("div", { class: "home-card-grid" });
  const live = h("div", { class: "live-list" });
  const root = h("div", { class: "home-card-root" }, head, grid, live);
  const nav = pushNav(root);

  // ── Detail (push-nav) ──────────────────────────────────────────────────────

  function closeDetail() {
    detailId = null;
    nav.pop();
    draw();
  }

  function openDetail(console: Console) {
    detailId = console.id;
    const sessions = liveSessionRows();
    const chips = h("div", { class: "cap-row" });
    if (console.can.streaming) chips.append(h("span", { class: "cap cap-can", text: t("consoles.cap.streams") }));
    if (console.can.resume) chips.append(h("span", { class: "cap cap-can", text: t("consoles.cap.resume") }));
    if (console.can.approvable) {
      chips.append(h("span", { class: "cap cap-can", text: t("consoles.cap.approvableHere") }));
    }

    const useBtn = button({
      label: console.id === State.agentCli ? t("consoles.inUse") : t("consoles.use"),
      variant: "primary",
      disabled: console.id === State.agentCli,
      onClick: () => {
        chooseProvider(console.id);
        opts.onPick?.();
        closeDetail();
      },
    });

    const body = h(
      "div",
      { class: "console-detail" },
      h(
        "div",
        { class: "console-detail-head" },
        stillMiniBot(consoleColor(console.id), 28),
        h("b", { text: console.label }),
        h("span", { class: "console-version", text: console.version }),
      ),
      chips,
      sessions.length > 0
        ? h("div", { class: "console-detail-sessions" }, h("div", { class: "live-title", text: t("consoles.runningNow") }), ...sessions)
        : null,
      h("div", { class: "home-card-detail-actions" }, useBtn),
    );

    nav.push(t("home.pane.consoles"), body);
  }

  // ── Rescan ────────────────────────────────────────────────────────────────

  async function rescan() {
    const before = new Set(availableClis.map((c) => c.id));
    rescanBtn.classList.add("spinning");
    await reloadConsoles();
    rescanBtn.classList.remove("spinning");
    const added = availableClis.filter((c) => !before.has(c.id)).length;
    toast(root, {
      message: added > 0 ? tn("consoles.foundNew", added) : t("consoles.noneNew"),
      tone: added > 0 ? "success" : "neutral",
    });
  }

  // ── Grid (either pane) ────────────────────────────────────────────────────

  function attachHoldAndDetail(el: HTMLElement, open: () => void) {
    el.tabIndex = 0;
    let holdTimer: number | null = null;
    let held = false;
    el.addEventListener("pointerdown", () => {
      held = false;
      holdTimer = window.setTimeout(() => {
        held = true;
        open();
      }, HOLD_MS);
    });
    const cancelHold = () => {
      if (holdTimer != null) window.clearTimeout(holdTimer);
      holdTimer = null;
    };
    el.addEventListener("pointerup", cancelHold);
    el.addEventListener("pointerleave", cancelHold);
    el.addEventListener("click", (e) => {
      if (held) {
        // The hold already opened the detail; the click that follows the
        // pointerup must not also select the console.
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      open();
    });
    el.addEventListener("keydown", (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Enter" && ke.shiftKey) {
        e.preventDefault();
        open();
      }
    });
  }

  function drawConsolesGrid() {
    clear(grid);
    grid.classList.toggle("empty", availableClis.length === 0);

    if (availableClis.length === 0) {
      grid.append(
        h(
          "div",
          { class: "console-empty-wide" },
          stillMiniBot("#8e939c", 20),
          h("span", { text: t("consoles.found") }),
          button({ label: t("consoles.rescan"), size: "md", onClick: () => void rescan() }),
        ),
      );
      dots.style.display = "none";
      return;
    }

    // `State.tasks` only ever carries one Claude Code session's metadata, and
    // only once it has been picked (see mock-bridge.ts's note on the same
    // gap) — so "is this console live" can only be known for the selected
    // one today. `liveIds` stays a set, not a bool, because orderConsoles()
    // is written for the general case; it is just never more than one
    // element until a live session can be tied to a console that isn't the
    // selection.
    const hasLiveSession = liveSessionRows().length > 0;
    const liveIds = new Set(hasLiveSession && State.agentCli ? [State.agentCli] : []);
    const ordered = orderConsoles(availableClis, State.agentCli, liveIds);
    const grouped = pages(ordered, PER_PAGE);
    consolePage = Math.min(consolePage, grouped.length - 1);
    const shown = grouped[consolePage] ?? [];

    clear(dots);
    dots.style.display = grouped.length > 1 ? "" : "none";
    grouped.forEach((_, i) => {
      const d = h("button", { class: i === consolePage ? "page-dot on" : "page-dot" });
      d.addEventListener("click", () => {
        consolePage = i;
        draw();
      });
      dots.append(d);
    });

    // The selection can vanish from under the list (uninstalled since it was
    // picked) — shown once, pinned to the grid rather than lost in a page.
    if (selectedConsoleMissing(State.agentCli, availableClis)) {
      const ghost = h(
        "div",
        { class: "pill pill-ghost", title: t("consoles.notFound") },
        h("span", { class: "mini ghost-face" }),
        h("span", { class: "lbl", text: "– –" }),
      );
      grid.append(ghost);
    }

    for (const console of shown) {
      const state = tileStateFor(console, State.agentCli);
      const el = tile({
        face: stillMiniBot(consoleColor(console.id), 20),
        name: console.label,
        color: consoleColor(console.id),
        badge: state === "selected" ? (hasLiveSession ? "live" : "finished") : null,
        onSelect: () => {
          chooseProvider(console.id);
          opts.onPick?.();
        },
      });
      el.classList.add(`console-tile-${state}`);
      if (state === "selected") el.style.setProperty("--tile-accent", consoleColor(console.id));
      el.title = `${console.version || t("settings.agents.versionUnknown")}`;
      attachHoldAndDetail(el, () => openDetail(console));
      grid.append(el);
    }
  }

  function drawServicesGrid() {
    clear(grid);
    dots.style.display = "none";
    for (const t of State.otherTasks.slice(0, PER_PAGE)) grid.append(servicePill(t, opts.setFocus));
    pruneMiniBots();
  }

  // ── Top-level keyboard: ←/→ changes the console page ────────────────────
  root.addEventListener("keydown", (e) => {
    if (pane !== "consoles" || detailId != null) return;
    const key = (e as KeyboardEvent).key;
    if (key !== "ArrowLeft" && key !== "ArrowRight") return;
    const grouped = pages(availableClis, PER_PAGE);
    if (grouped.length < 2) return;
    e.preventDefault();
    consolePage = (consolePage + (key === "ArrowRight" ? 1 : -1) + grouped.length) % grouped.length;
    draw();
  });

  let shownShape = "";

  function draw() {
    rescanBtn.style.display = pane === "consoles" ? "" : "none";
    if (pane === "consoles") {
      drawConsolesGrid();
      clear(live);
      const sessions = liveSessionRows();
      if (sessions.length > 0) {
        live.append(h("div", { class: "live-title", text: t("consoles.runningNow") }), ...sessions);
      }
    } else {
      drawServicesGrid();
      clear(live);
    }
  }

  draw();

  return {
    el: nav.el,
    sync() {
      if (detailId != null) return; // the detail frame owns the card while open
      const shape = [
        pane,
        availableClis.map((c) => `${c.id}:${c.version}`).join("|"),
        State.agentCli,
        State.tasks.map((t) => `${t.id}:${t.name}:${t.host ?? ""}:${t.state}`).join("|"),
        State.otherTasks.map((t) => `${t.id}:${t.pillBadge ?? ""}`).join("|"),
        getLocale(),
      ].join("~");
      if (shape === shownShape) return;
      shownShape = shape;
      draw();
    },
    focus() {
      rescanOnFocus();
      root.focus();
    },
  };
}
