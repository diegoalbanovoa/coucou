// The System tab: how much room is left, how much memory is in use, and a
// broom that shows its work before it does any.
//
// The sequence is fixed and the whole point: scan, show what was found with
// its size, and delete only when a second button is pressed. The first button
// never deletes anything, and there is no way to reach the second without the
// first — a cleaner that can delete on one click is a cleaner that will.
//
// Polling only happens while this view is on screen. The island's frame loop
// stops when nothing moves, and a tab nobody has open must cost nothing.

import { h, clear } from "./dom";
import { icon } from "./icons";
import { Bridge, type Found, type ProcInfo, type Stats, type Swept } from "../core/bridge";
import { t, tn, getLocale } from "../i18n/index";

/** How often the numbers refresh while the tab is open. */
const POLL_MS = 3_000;

/** The targets the tab offers, in this order. Rust holds the paths. */
const TARGETS = ["temp", "recycle", "npm-cache", "pip-cache", "coucou-inbox"];

/** Bytes as a person reads them. */
export function size(bytes: number): string {
  // `NaN <= 0` is false, so without this the walk through the units lands on
  // `units[NaN]` and the tab reads "NaN undefined".
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** power;
  // One decimal below ten, none above: "9.4 GB" and "140 GB" both read at a
  // glance, "9.44 GB" and "140.2 GB" do not.
  return `${value < 10 && power > 0 ? value.toFixed(1) : Math.round(value)} ${units[power]}`;
}

/** What one thing would free, as the preview line reads. */
export function foundLine(found: Found): string {
  if (found.note) return found.note;
  if (found.files === 0) return t("system.nothingToClean");
  return `${tn("system.fileCount", found.files)} · ${size(found.bytes)}`;
}

/** What it actually freed. */
export function sweptLine(swept: Swept): string {
  const freed = tn("system.removedFreed", swept.files, { size: size(swept.bytes) });
  return swept.inUse > 0 ? `${freed} · ${tn("system.inUseLeftAlone", swept.inUse)}` : freed;
}

/** A bar for a proportion, with the colour saying when it matters. */
function meter(used: number, total: number): HTMLElement {
  const share = total > 0 ? Math.min(1, used / total) : 0;
  const fill = h("i", { style: `width:${(share * 100).toFixed(1)}%` });
  const bar = h("div", { class: "meter" }, fill);
  // Semantic, not decorative: the colour is the warning.
  bar.classList.toggle("tight", share > 0.9);
  bar.classList.toggle("close", share > 0.75 && share <= 0.9);
  return bar;
}

export function buildSystem() {
  const stats = h("div", { class: "sys-stats" });
  const cleanup = h("div", { class: "sys-cleanup" });
  const procs = h("div", { class: "sys-procs" });
  const list = h("div", { class: "sys-list" });
  const actions = h("div", { class: "sys-actions" });
  const result = h("div", { class: "sys-result" });

  const diskCleanupBtn = h("button", { class: "sys-btn quiet", text: t("system.openCleanup") });
  cleanup.append(diskCleanupBtn);
  diskCleanupBtn.addEventListener("click", async () => {
    diskCleanupBtn.disabled = true;
    const started = await Bridge.systemOpenDiskCleanup();
    diskCleanupBtn.disabled = false;
    if (!started) diskCleanupBtn.textContent = t("system.cleanupFailed");
  });

  const scanBtn = h("button", { class: "sys-btn", text: t("system.scanFirst") });
  const cleanBtn = h("button", { class: "sys-btn danger" });
  const cancelBtn = h("button", { class: "sys-btn quiet", text: t("system.neverMind") });
  actions.append(scanBtn, cleanBtn, cancelBtn);

  const el = h(
    "div",
    { class: "view" },
    h(
      "div",
      { class: "card wash sys-card" },
      h("div", { class: "sys-body" }, stats, cleanup, procs, list, actions, result),
    ),
  );

  /** What the last scan found. Empty until the first scan. */
  let found: Found[] = [];
  /** Which targets are ticked. */
  const chosen = new Set(TARGETS);
  let timer: number | null = null;
  let shown = "";
  let shownProcs = "";
  let shownLocale = getLocale();
  /** The pid waiting on a second click, if any. Never more than one at once. */
  let endPid: number | null = null;

  function drawStats(s: Stats) {
    const key = JSON.stringify(s);
    if (key === shown) return;
    shown = key;

    clear(stats);
    for (const drive of s.drives) {
      const used = drive.total - drive.free;
      stats.append(
        h(
          "div",
          { class: "sys-stat" },
          icon("disk", { size: 12 }),
          h("span", { class: "sys-stat-name", text: drive.name }),
          meter(used, drive.total),
          h("span", { class: "sys-stat-value", text: t("system.free", { size: size(drive.free) }) }),
        ),
      );
    }
    if (s.memoryTotal > 0) {
      stats.append(
        h(
          "div",
          { class: "sys-stat" },
          icon("memory", { size: 12 }),
          h("span", { class: "sys-stat-name", text: t("system.memory") }),
          meter(s.memoryUsed, s.memoryTotal),
          h("span", {
            class: "sys-stat-value",
            text: t("system.usedOf", { used: size(s.memoryUsed), total: size(s.memoryTotal) }),
          }),
        ),
      );
    }
    cleanup.style.display = s.diskCleanupAvailable ? "" : "none";
  }

  /** The heaviest processes, each with a button that asks before it ends one. */
  function drawProcs(list: ProcInfo[]) {
    const key = JSON.stringify(list) + endPid + getLocale();
    if (key === shownProcs) return;
    shownProcs = key;

    clear(procs);
    if (list.length === 0) return;
    procs.append(h("div", { class: "sys-procs-title", text: t("system.topMemory") }));

    for (const p of list) {
      const row = h(
        "div",
        { class: "sys-proc" },
        h("span", { class: "sys-proc-name", text: p.name }),
        h("span", { class: "sys-proc-mem", text: size(p.memory) }),
      );

      if (endPid === p.pid) {
        const yes = h("button", { class: "sys-proc-yes", text: t("system.endProcess") });
        const no = h("button", { class: "sys-proc-no", text: t("system.neverMind") });
        yes.addEventListener("click", async () => {
          yes.disabled = true;
          try {
            await Bridge.systemKillProcess(p.pid);
            clear(result);
          } catch (err) {
            result.textContent = String(err);
          }
          endPid = null;
          void refreshProcs();
        });
        no.addEventListener("click", () => {
          endPid = null;
          drawProcs(list);
        });
        row.append(h("span", { class: "sys-proc-confirm" }, yes, no));
      } else {
        const end = h("button", { class: "sys-proc-end", title: t("system.endProcessTitle", { name: p.name }) });
        end.append(icon("xmark", { size: 10 }));
        end.addEventListener("click", () => {
          endPid = p.pid;
          drawProcs(list);
        });
        row.append(end);
      }
      procs.append(row);
    }
  }

  /** The tick boxes, and the preview once there is one. */
  function drawList() {
    clear(list);
    const byId = new Map(found.map((f) => [f.id, f]));

    for (const id of TARGETS) {
      const f = byId.get(id);
      const on = chosen.has(id);
      const box = h("button", { class: on ? "sys-row on" : "sys-row" });
      box.append(
        h("i", { class: "sys-tick" }, on ? icon("check", { size: 9 }) : h("span")),
        h(
          "span",
          { class: "sys-row-text" },
          h("b", { text: f?.label ?? id }),
          // The description comes with the scan, so before the first one there
          // is nothing honest to say but that nothing has been looked at.
          h("span", { class: "sys-row-about", text: f ? foundLine(f) : t("system.notLookedAt") }),
        ),
      );
      box.title = f?.path ?? "";
      box.addEventListener("click", () => {
        if (on) chosen.delete(id);
        else chosen.add(id);
        drawList();
        drawActions();
      });
      list.append(box);
    }
  }

  function totalFound(): { files: number; bytes: number } {
    return found
      .filter((f) => chosen.has(f.id))
      .reduce(
        (sum, f) => ({ files: sum.files + f.files, bytes: sum.bytes + f.bytes }),
        { files: 0, bytes: 0 },
      );
  }

  function drawActions() {
    const total = totalFound();
    const previewed = found.length > 0 && total.files > 0;

    scanBtn.textContent = found.length > 0 ? t("system.scanAgain") : t("system.scanFirst");
    scanBtn.disabled = chosen.size === 0;

    // The delete button exists only once a scan has something to delete, and
    // says exactly what it will take.
    cleanBtn.style.display = previewed ? "" : "none";
    cleanBtn.textContent = tn("system.deleteN", total.files, { size: size(total.bytes) });
    cancelBtn.style.display = previewed ? "" : "none";
  }

  scanBtn.addEventListener("click", async () => {
    clear(result);
    scanBtn.disabled = true;
    found = (await Bridge.systemScan([...chosen])) ?? [];
    drawList();
    drawActions();
  });

  cancelBtn.addEventListener("click", () => {
    found = [];
    clear(result);
    drawList();
    drawActions();
  });

  cleanBtn.addEventListener("click", async () => {
    const ids = found.filter((f) => chosen.has(f.id) && f.files > 0).map((f) => f.id);
    cleanBtn.disabled = true;
    const swept = (await Bridge.systemClean(ids)) ?? [];
    cleanBtn.disabled = false;

    clear(result);
    for (const s of swept) {
      const label = found.find((f) => f.id === s.id)?.label ?? s.id;
      result.append(
        h("div", { class: "sys-swept" }, h("b", { text: label }), h("span", { text: sweptLine(s) })),
      );
    }
    // The preview is now a lie, so it goes rather than being left to re-read.
    found = [];
    drawList();
    drawActions();
    void refresh();
  });

  async function refresh() {
    const s = await Bridge.systemStats();
    if (s) drawStats(s);
    void refreshProcs();
  }

  async function refreshProcs() {
    const list = await Bridge.systemProcesses();
    if (list) drawProcs(list);
  }

  drawList();
  drawActions();

  return {
    el,
    sync() {
      // Everything here is otherwise redrawn by the poll or by whatever the
      // user just clicked — except the language, which can change while this
      // tab just sits there, so it is the one thing worth checking on every
      // sync rather than waiting for the next click or poll tick to catch up.
      if (getLocale() === shownLocale) return;
      shownLocale = getLocale();
      diskCleanupBtn.textContent = t("system.openCleanup");
      shown = ""; // forces drawStats to redraw "Memory"/"{free} free" next poll
      drawList();
      drawActions();
      void refresh();
    },
    focus() {
      void refresh();
      if (timer == null) timer = window.setInterval(() => void refresh(), POLL_MS);
    },
    /** Called when the view goes away, so the poll stops with it. */
    blur() {
      if (timer != null) {
        window.clearInterval(timer);
        timer = null;
      }
    },
  };
}
