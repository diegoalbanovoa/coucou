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
import { Bridge, type Found, type Stats, type Swept } from "../core/bridge";

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
  if (found.files === 0) return "nothing to clean";
  return `${found.files} ${found.files === 1 ? "file" : "files"} · ${size(found.bytes)}`;
}

/** What it actually freed. */
export function sweptLine(swept: Swept): string {
  const freed = `${swept.files} removed · ${size(swept.bytes)} freed`;
  return swept.inUse > 0 ? `${freed} · ${swept.inUse} in use, left alone` : freed;
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
  const list = h("div", { class: "sys-list" });
  const actions = h("div", { class: "sys-actions" });
  const result = h("div", { class: "sys-result" });

  const scanBtn = h("button", { class: "sys-btn", text: "Look for what can go" });
  const cleanBtn = h("button", { class: "sys-btn danger" });
  const cancelBtn = h("button", { class: "sys-btn quiet", text: "Never mind" });
  actions.append(scanBtn, cleanBtn, cancelBtn);

  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card wash sys-card" }, h("div", { class: "sys-body" }, stats, list, actions, result)),
  );

  /** What the last scan found. Empty until the first scan. */
  let found: Found[] = [];
  /** Which targets are ticked. */
  const chosen = new Set(TARGETS);
  let timer: number | null = null;
  let shown = "";

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
          h("span", { class: "sys-stat-value", text: `${size(drive.free)} free` }),
        ),
      );
    }
    if (s.memoryTotal > 0) {
      stats.append(
        h(
          "div",
          { class: "sys-stat" },
          icon("memory", { size: 12 }),
          h("span", { class: "sys-stat-name", text: "Memory" }),
          meter(s.memoryUsed, s.memoryTotal),
          h("span", {
            class: "sys-stat-value",
            text: `${size(s.memoryUsed)} of ${size(s.memoryTotal)}`,
          }),
        ),
      );
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
          h("span", { class: "sys-row-about", text: f ? foundLine(f) : "not looked at yet" }),
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

    scanBtn.textContent = found.length > 0 ? "Look again" : "Look for what can go";
    scanBtn.disabled = chosen.size === 0;

    // The delete button exists only once a scan has something to delete, and
    // says exactly what it will take.
    cleanBtn.style.display = previewed ? "" : "none";
    cleanBtn.textContent = `Delete ${total.files} ${total.files === 1 ? "file" : "files"} · ${size(total.bytes)}`;
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
  }

  drawList();
  drawActions();

  return {
    el,
    sync() {
      // Nothing to do here: the numbers come from the poll, and the lists are
      // redrawn by the things that change them.
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
