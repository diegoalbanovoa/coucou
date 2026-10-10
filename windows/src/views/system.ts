// The System tab: "is my machine okay", then "what is slowing it down and
// what can I do" (plan-v2.md § 6.1).
//
// Mochi sits large in the left column (reserved by `.sys-body`'s padding,
// not drawn here — island.ts's frame loop owns the bot canvas). To its
// right: a headline, three ring gauges (CPU, memory, the first drive), a
// Procesos/Almacenamiento switch, and whichever of those two lists is
// showing. "Free up space…" opens a sheet over all of it — scan, then a
// second click before anything is deleted, same as it always was.
//
// Polling only happens while this view is on screen, and the heavier
// process poll only while its own pane is the one showing.

import { h, clear, dot } from "./dom";
import { icon } from "./icons";
import { Bridge, type EndTarget, type Found, type ProcInfo, type Stats, type Swept } from "../core/bridge";
import { t, tn, getLocale } from "../i18n/index";
import { State } from "../core/state";
import { gauge, toneFor, DISK_THRESHOLDS, type GaugeTone } from "../ui/gauge";
import { segmented, type Segmented } from "../ui/segmented";
import { listRow } from "../ui/list-row";
import { inlineConfirm } from "../ui/inline-confirm";
import { sheet } from "../ui/sheet";
import { button } from "../ui/button";
import { iconButton } from "../ui/icon-button";
import { toast } from "../ui/toast";
import { stillMiniBot } from "../mochi/minibots";
import { consoleColor } from "../consoles/palette";

/** How often the headline, gauges and drive list refresh while the tab is
 *  open — one `system_stats` call covers all three, so there is only one
 *  timer for them rather than the plan's separate 1s/30s rows. */
const STATS_POLL_MS = 2_000;
/** How often the process list refreshes, and only while its own pane is
 *  the one showing. */
const PROCS_POLL_MS = 3_000;

/** The targets the cleanup sheet offers, in this order. Rust holds the paths. */
const TARGETS = ["temp", "recycle", "npm-cache", "pip-cache", "coucou-inbox", "coucou-log"];

/** Rust's `Found.label` is an untranslated, English, internal-log-friendly
 *  string (see system.rs's `targets()`) — never shown. The sheet's own
 *  labels come from here instead, keyed by the same ids. */
function targetLabel(id: string): string {
  switch (id) {
    case "temp":
      return t("system.target.temp");
    case "recycle":
      return t("system.target.recycle");
    case "npm-cache":
      return t("system.target.npmCache");
    case "pip-cache":
      return t("system.target.pipCache");
    case "coucou-inbox":
      return t("system.target.coucouInbox");
    case "coucou-log":
      return t("system.target.coucouLog");
    default:
      return id;
  }
}

/** Agent CLI executables (plan-v2.md § 3.2's palette) — a process whose name
 *  is one of these, case-insensitively and with or without `.exe`, gets its
 *  console's face instead of a plain hashed circle, and its end-confirm gets
 *  the extra warning line. */
const AGENT_STEMS = ["claude", "gemini", "codex", "copilot", "cursor-agent", "qwen", "opencode"];

function exeStem(name: string): string {
  return name.toLowerCase().replace(/\.exe$/, "");
}

export function isAgentProcess(name: string): boolean {
  return AGENT_STEMS.includes(exeStem(name));
}

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

/** One executable's processes, folded into a single row (plan-v2.md § 6.4). */
export interface ProcGroup {
  /** Lower-cased executable name — stable identity for DOM-diffing and for
   *  the end-request's target list, independent of display casing. */
  key: string;
  name: string;
  count: number;
  memory: number;
  /** True the moment any member is — a protected process never shares its
   *  executable name with an ordinary one in practice, so the group as a
   *  whole simply inherits it. */
  protected: boolean;
  members: { pid: number; startTime: number; memory: number }[];
}

/** Groups a flat process list by executable name, heaviest group first. */
export function groupProcesses(list: ProcInfo[]): ProcGroup[] {
  const groups = new Map<string, ProcGroup>();
  for (const p of list) {
    const key = p.name.toLowerCase();
    let g = groups.get(key);
    if (!g) {
      g = { key, name: p.name, count: 0, memory: 0, protected: false, members: [] };
      groups.set(key, g);
    }
    g.count += 1;
    g.memory += p.memory;
    g.protected = g.protected || p.protected;
    g.members.push({ pid: p.pid, startTime: p.startTime, memory: p.memory });
  }
  return [...groups.values()].sort((a, b) => b.memory - a.memory);
}

const TONE_RANK: Record<GaugeTone, number> = { green: 0, orange: 1, red: 2 };

/** The worse of the two readings — what the headline and its dot answer
 *  "is my machine okay" with. */
export function overallTone(cpuPercent: number, memoryPercent: number): GaugeTone {
  const cpu = toneFor(cpuPercent);
  const memory = toneFor(memoryPercent);
  return TONE_RANK[cpu] >= TONE_RANK[memory] ? cpu : memory;
}

const STATUS_KEY: Record<GaugeTone, "system.statusOk" | "system.statusStrained" | "system.statusSick"> = {
  green: "system.statusOk",
  orange: "system.statusStrained",
  red: "system.statusSick",
};

/** The sentence a gauge's `aria-label` reads as a whole — see ui/gauge.ts's
 *  file note on why composing it is the caller's job, not the ring's. */
export function gaugeAria(tone: GaugeTone, label: string, value: number, detail: string): string {
  const key = tone === "red" ? "system.gaugeCritical" : tone === "orange" ? "system.gaugeHigh" : "system.gaugeNormal";
  return t(key, { label, value, detail });
}

const AVATAR_PALETTE = ["--c-blue", "--c-purple", "--c-teal", "--c-green", "--c-yellow", "--c-accent"];

/** A stable colour for a process name this tab has no better face for —
 *  the same name always lands on the same hue, which is all a reader needs
 *  to tell "another one of these" from "something new" at a glance. */
function hashColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return `var(${AVATAR_PALETTE[hash % AVATAR_PALETTE.length]})`;
}

function avatarFor(name: string): HTMLElement {
  const stem = exeStem(name);
  if (AGENT_STEMS.includes(stem)) return stillMiniBot(consoleColor(stem), 20);
  return h(
    "span",
    { class: "proc-avatar", style: `background:${hashColor(name)}` },
    name.charAt(0).toUpperCase(),
  );
}

type Pane = "processes" | "storage";
type SheetStep = "closed" | "analyzing" | "results" | "cleaning" | "result";

export function buildSystem() {
  const headDot = dot("var(--c-green)", 8);
  const headlineText = h("b", { class: "sys-headline" });
  const detailText = h("span", { class: "sys-detail" });
  const head = h("div", { class: "sys-head" }, headDot, h("div", { class: "sys-head-text" }, headlineText, detailText));

  const gaugesRow = h("div", { class: "sys-gauges" });
  const panel = h("div", { class: "sys-panel" });

  let pane: Pane = "processes";

  function buildSegmented(): Segmented<Pane> {
    return segmented<Pane>({
      items: [
        { value: "processes", label: t("system.tabProcesses") },
        { value: "storage", label: t("system.tabStorage") },
      ],
      value: pane,
      onChange: (v) => {
        pane = v;
        drawPanel();
      },
    });
  }

  let seg = buildSegmented();
  // `.ui-sheet`'s `inset` is relative to its positioned ancestor's padding
  // box, which includes that ancestor's own padding — so mounting it
  // straight on `.sys-body` (whose left padding reserves Mochi's column)
  // would cover that column rather than respect it. `.sys-content` carries
  // no padding of its own, just the `position: relative` the sheet needs,
  // so its padding box starts exactly where `.sys-body`'s reserved column
  // ends.
  const content = h("div", { class: "sys-content" }, head, gaugesRow, seg.el, panel);
  const body = h("div", { class: "sys-body" }, content);
  const el = h("div", { class: "view" }, h("div", { class: "card wash sys-card" }, body));

  let stats: Stats | null = null;
  let procs: ProcInfo[] = [];
  let expanded = false;
  let openMenuKey: string | null = null;
  let confirmKey: string | null = null;
  let membersKey: string | null = null;

  let sheetStep: SheetStep = "closed";
  let sheetEl: HTMLElement | null = null;
  let foundList: Found[] = [];
  let sweptList: Swept[] = [];
  const chosen = new Set(TARGETS);
  let cleaned = 0;
  let cleanTotal = 0;

  let statsTimer: number | null = null;
  let procsTimer: number | null = null;
  let shownLocale = getLocale();

  // ── Headline and gauges ─────────────────────────────────────────────────

  function memPercent(s: Stats): number {
    return s.memoryTotal > 0 ? (s.memoryUsed / s.memoryTotal) * 100 : 0;
  }

  function drawHead(s: Stats) {
    const tone = overallTone(s.cpuPercent, memPercent(s));
    headDot.style.background = `var(--c-${tone})`;
    headlineText.textContent = t(STATUS_KEY[tone]);
    detailText.textContent = t("system.detail", {
      mem: `${Math.round(memPercent(s))}%`,
      cpu: `${Math.round(s.cpuPercent)}%`,
    });
  }

  function gaugeButton(inner: HTMLElement, onClick: () => void): HTMLElement {
    return h("button", { class: "sys-gauge-btn", onclick: onClick }, inner);
  }

  function goTo(next: Pane) {
    pane = next;
    seg.setValue(next);
    drawPanel();
  }

  function drawGauges(s: Stats) {
    clear(gaugesRow);
    const mem = memPercent(s);

    const cpuDetail = tn("system.cores", s.cores);
    gaugesRow.append(
      gaugeButton(
        gauge({
          value: s.cpuPercent,
          label: t("system.cpuLabel"),
          detail: cpuDetail,
          ariaLabel: gaugeAria(toneFor(s.cpuPercent), t("system.cpuLabel"), Math.round(s.cpuPercent), cpuDetail),
        }),
        () => goTo("processes"),
      ),
    );

    const memDetail = t("system.usedOf", { used: size(s.memoryUsed), total: size(s.memoryTotal) });
    gaugesRow.append(
      gaugeButton(
        gauge({
          value: mem,
          label: t("system.memoryLabel"),
          detail: memDetail,
          ariaLabel: gaugeAria(toneFor(mem), t("system.memoryLabel"), Math.round(mem), memDetail),
        }),
        () => goTo("processes"),
      ),
    );

    const drive = s.drives[0];
    if (drive) {
      const used = drive.total - drive.free;
      const pct = drive.total > 0 ? (used / drive.total) * 100 : 0;
      const driveDetail = t("system.free", { size: size(drive.free) });
      gaugesRow.append(
        gaugeButton(
          gauge({
            value: pct,
            label: drive.name,
            detail: driveDetail,
            thresholds: DISK_THRESHOLDS,
            ariaLabel: gaugeAria(toneFor(pct, DISK_THRESHOLDS), drive.name, Math.round(pct), driveDetail),
          }),
          () => goTo("storage"),
        ),
      );
    }
  }

  // ── Processes pane ───────────────────────────────────────────────────────

  function drawPanel() {
    if (pane === "processes") drawProcesses();
    else drawStorage();
  }

  /** `key` → the row's last on-screen position, read just before this redraw
   *  clears it — plan-v2.md § 6.4: "si una fila cambia de posición, se mueve
   *  ... no salta." A row whose key survives the redraw animates from its
   *  old spot to its new one (a minimal FLIP); a brand-new or removed key
   *  has nothing to animate from and just appears or disappears. */
  function drawProcesses() {
    const prevTops = new Map<string, number>();
    for (const rowEl of panel.querySelectorAll<HTMLElement>("[data-proc-key]")) {
      prevTops.set(rowEl.dataset.procKey!, rowEl.getBoundingClientRect().top);
    }
    clear(panel);

    const groups = groupProcesses(procs);
    const limit = expanded ? 20 : 8;
    const shown = groups.slice(0, limit);
    const largest = groups[0]?.memory || 1;

    const list = h("div", { class: "proc-list" });
    for (const g of shown) list.append(procRow(g, largest));
    panel.append(list);

    if (groups.length > 8 && !expanded) {
      panel.append(
        h("button", {
          class: "sys-see-more",
          text: t("system.seeMore"),
          onclick: () => {
            expanded = true;
            drawProcesses();
          },
        }),
      );
    }

    for (const rowEl of list.querySelectorAll<HTMLElement>("[data-proc-key]")) {
      const prevTop = prevTops.get(rowEl.dataset.procKey!);
      if (prevTop == null) continue;
      const dy = prevTop - rowEl.getBoundingClientRect().top;
      if (dy === 0) continue;
      rowEl.style.transition = "none";
      rowEl.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => {
        rowEl.style.transition = `transform var(--d-base) var(--ease-out)`;
        rowEl.style.transform = "";
      });
    }
  }

  function procRow(g: ProcGroup, largest: number): HTMLElement {
    const barPct = Math.min(100, (g.memory / largest) * 100);
    const main = h(
      "div",
      { class: "proc-row-main" },
      avatarFor(g.name),
      h(
        "div",
        { class: "proc-row-text" },
        h("span", { class: "proc-row-name" }, h("b", {}, g.name), g.count > 1 ? h("span", { class: "proc-badge" }, `×${g.count}`) : null),
        h("div", { class: "proc-bar" }, h("i", { style: `width:${barPct}%` })),
      ),
      h("span", { class: "proc-value", text: size(g.memory) }),
      g.protected
        ? h("span", { class: "proc-lock", title: t("system.protected") }, icon("lock", { size: 12 }))
        : iconButton({
            icon: "ellipsis",
            label: t("system.moreActions"),
            onClick: () => {
              openMenuKey = openMenuKey === g.key ? null : g.key;
              drawProcesses();
            },
          }),
    );

    const row = h("div", { class: "proc-row", "data-proc-key": g.key }, main);
    if (openMenuKey === g.key) row.append(procMenu(g));
    if (confirmKey === g.key) row.append(procConfirm(g));
    if (membersKey === g.key) row.append(procMembers(g));
    return row;
  }

  function procMenu(g: ProcGroup): HTMLElement {
    return h(
      "div",
      { class: "proc-menu" },
      h("button", {
        class: "ui-btn ui-btn-plain ui-btn-md",
        text: tn("system.viewProcesses", g.count),
        onclick: () => {
          membersKey = membersKey === g.key ? null : g.key;
          openMenuKey = null;
          drawProcesses();
        },
      }),
      h("button", {
        class: "ui-btn ui-btn-destructive ui-btn-md",
        text: t("system.endProcess"),
        onclick: () => {
          confirmKey = g.key;
          openMenuKey = null;
          drawProcesses();
        },
      }),
    );
  }

  function procConfirm(g: ProcGroup): HTMLElement {
    const message = isAgentProcess(g.name)
      ? `${tn("system.endConfirmGroup", g.count, { name: g.name })} ${t("system.agentWarning")}`
      : tn("system.endConfirmGroup", g.count, { name: g.name });
    return inlineConfirm({
      message,
      confirmLabel: t("system.endProcess"),
      cancelLabel: t("system.neverMind"),
      destructive: true,
      onConfirm: async () => {
        confirmKey = null;
        drawProcesses();
        const targets: EndTarget[] = g.members.map((m) => ({ pid: m.pid, startTime: m.startTime }));
        const failed = (await Bridge.systemEndProcess(targets)) ?? [];
        if (failed.length > 0) toast(el, { message: tn("system.endFailed", failed.length), tone: "error" });
        void refreshProcs();
      },
      onCancel: () => {
        confirmKey = null;
        drawProcesses();
      },
    });
  }

  function procMembers(g: ProcGroup): HTMLElement {
    return h(
      "div",
      { class: "proc-members" },
      ...g.members.map((m) =>
        h(
          "div",
          { class: "proc-member" },
          h("span", { text: `PID ${m.pid}` }),
          h("span", { class: "proc-member-mem", text: size(m.memory) }),
        ),
      ),
    );
  }

  // ── Storage pane ─────────────────────────────────────────────────────────

  function drawStorage() {
    clear(panel);
    if (!stats) return;
    const list = h("div", { class: "drive-list" });
    for (const d of stats.drives) {
      const used = d.total - d.free;
      const pct = d.total > 0 ? (used / d.total) * 100 : 0;
      const tone = toneFor(pct, DISK_THRESHOLDS);
      const bar = h("div", { class: `drive-bar drive-bar-${tone}` }, h("i", { style: `width:${pct}%` }));
      list.append(
        listRow({
          leading: icon("disk", { size: 14 }),
          title: d.name,
          subtitle: t("system.driveFree", { free: size(d.free), total: size(d.total) }),
          trailing: bar,
        }),
      );
    }
    panel.append(list);
    panel.append(
      h(
        "div",
        { class: "sys-panel-actions" },
        button({ label: t("system.freeUpSpace"), variant: "primary", onClick: openSheet }),
      ),
    );
  }

  // ── The cleanup sheet ────────────────────────────────────────────────────

  function openSheet() {
    sheetStep = "analyzing";
    drawSheet();
    void (async () => {
      foundList = (await Bridge.systemScan([...chosen])) ?? [];
      sheetStep = "results";
      drawSheet();
    })();
  }

  function closeSheet() {
    sheetStep = "closed";
    drawSheet();
  }

  function drawSheet() {
    sheetEl?.remove();
    sheetEl = null;
    if (sheetStep === "closed") return;
    sheetEl = sheet({
      title: t("system.freeUpSpace"),
      body: sheetBody(),
      footer: sheetFooter(),
      closeLabel: t("common.cancel"),
      onClose: closeSheet,
    });
    content.append(sheetEl);
  }

  function sheetBody(): Node {
    if (sheetStep === "analyzing") return sheetSkeleton();
    if (sheetStep === "cleaning") return sheetCleaning();
    if (sheetStep === "result") return sheetResult();
    return sheetResults();
  }

  function sheetSkeleton(): Node {
    return h(
      "div",
      { class: "sheet-skel" },
      h("span", { class: "sheet-step-label", text: t("system.analyzing") }),
      ...TARGETS.map(() => h("div", { class: "sheet-skel-row" })),
    );
  }

  function sheetResults(): Node {
    const byId = new Map(foundList.map((f) => [f.id, f]));
    const rows = TARGETS.map((id) => {
      const f = byId.get(id);
      const on = chosen.has(id);
      return h(
        "button",
        {
          class: on ? "sys-row on" : "sys-row",
          onclick: () => {
            if (on) chosen.delete(id);
            else chosen.add(id);
            drawSheet();
          },
        },
        h("i", { class: "sys-tick" }, on ? icon("check", { size: 9 }) : h("span")),
        h(
          "span",
          { class: "sys-row-text" },
          h("b", { text: targetLabel(id) }),
          h("span", { class: "sys-row-about", text: f ? foundLine(f) : t("system.notLookedAt") }),
        ),
      );
    });

    const disabled = [t("system.windowsTemp"), t("system.windowsUpdate")].map((label) =>
      h(
        "div",
        { class: "sys-row disabled" },
        h("i", { class: "sys-tick" }),
        h("span", { class: "sys-row-text" }, h("b", { text: label }), h("span", { class: "sys-row-about", text: t("system.needsAdmin") })),
      ),
    );

    const openCleanupLink = stats?.diskCleanupAvailable
      ? h("button", {
          class: "sheet-link",
          text: t("system.openCleanup"),
          onclick: async (e: Event) => {
            const btn = e.currentTarget as HTMLButtonElement;
            btn.disabled = true;
            const started = await Bridge.systemOpenDiskCleanup();
            btn.disabled = false;
            if (!started) btn.textContent = t("system.cleanupFailed");
          },
        })
      : null;

    return h("div", { class: "sheet-results" }, ...rows, ...disabled, openCleanupLink);
  }

  function sheetCleaning(): Node {
    const pct = cleanTotal > 0 ? (cleaned / cleanTotal) * 100 : 0;
    return h(
      "div",
      { class: "sheet-progress" },
      h("span", { class: "sheet-step-label", text: t("system.cleaning") }),
      h("div", { class: "sheet-progress-track" }, h("i", { class: "sheet-progress-fill", style: `width:${pct}%` })),
    );
  }

  function sheetResult(): Node {
    const totalFiles = sweptList.reduce((sum, s) => sum + s.files, 0);
    const totalBytes = sweptList.reduce((sum, s) => sum + s.bytes, 0);
    return h(
      "div",
      { class: "sheet-result" },
      h("div", { class: "sheet-result-check" }, icon("check", { size: 28 })),
      h("b", { class: "sheet-result-headline", text: t("common.done") }),
      h("span", { class: "sheet-result-sub", text: tn("system.removedFreed", totalFiles, { size: size(totalBytes) }) }),
      ...sweptList.map((s) => {
        const label = targetLabel(s.id);
        return h("div", { class: "sys-swept" }, h("b", { text: label }), h("span", { text: sweptLine(s) }));
      }),
    );
  }

  function sheetFooter(): Node | undefined {
    if (sheetStep === "results") {
      const total = [...chosen].reduce(
        (sum, id) => {
          const f = foundList.find((x) => x.id === id);
          return f ? { files: sum.files + f.files, bytes: sum.bytes + f.bytes } : sum;
        },
        { files: 0, bytes: 0 },
      );
      return h(
        "div",
        { class: "sheet-footer-row" },
        button({
          label: tn("system.deleteN", total.files, { size: size(total.bytes) }),
          variant: "destructive",
          disabled: total.files === 0,
          onClick: startCleaning,
        }),
      );
    }
    if (sheetStep === "result") {
      return button({ label: t("common.done"), variant: "primary", onClick: closeSheet });
    }
    return undefined;
  }

  async function startCleaning() {
    const ids = TARGETS.filter((id) => chosen.has(id) && (foundList.find((f) => f.id === id)?.files ?? 0) > 0);
    sheetStep = "cleaning";
    cleaned = 0;
    cleanTotal = ids.length;
    sweptList = [];
    drawSheet();

    for (const id of ids) {
      const result = (await Bridge.systemClean([id])) ?? [];
      sweptList.push(...result);
      cleaned += 1;
      drawSheet();
    }

    sheetStep = "result";
    drawSheet();
    void refresh();
  }

  // ── Polling ──────────────────────────────────────────────────────────────

  async function refresh() {
    const s = await Bridge.systemStats();
    if (!s) return;
    stats = s;
    drawHead(s);
    drawGauges(s);
    if (pane === "storage" && sheetStep === "closed") drawPanel();
  }

  async function refreshProcs() {
    const list = await Bridge.systemProcesses();
    if (!list) return;
    procs = list;
    if (pane === "processes") drawProcesses();
  }

  drawPanel();

  return {
    el,
    sync() {
      // Everything else is redrawn by the poll or by whatever was just
      // clicked — language is the one thing that can change while this tab
      // just sits there, so it is the one thing worth checking here.
      if (getLocale() === shownLocale) return;
      shownLocale = getLocale();
      const newSeg = buildSegmented();
      content.replaceChild(newSeg.el, seg.el);
      seg = newSeg;
      if (stats) {
        drawHead(stats);
        drawGauges(stats);
      }
      drawPanel();
      if (sheetStep !== "closed") drawSheet();
    },
    focus() {
      if (State.systemInitialPane) {
        const initial = State.systemInitialPane;
        State.systemInitialPane = null;
        goTo(initial);
      }
      void refresh();
      void refreshProcs();
      if (statsTimer == null) statsTimer = window.setInterval(() => void refresh(), STATS_POLL_MS);
      if (procsTimer == null) procsTimer = window.setInterval(() => void refreshProcs(), PROCS_POLL_MS);
      if (State.systemOpenCleanupSheet) {
        State.systemOpenCleanupSheet = false;
        openSheet();
      }
    },
    /** Called when the view goes away, so the polls stop with it. */
    blur() {
      if (statsTimer != null) {
        window.clearInterval(statsTimer);
        statsTimer = null;
      }
      if (procsTimer != null) {
        window.clearInterval(procsTimer);
        procsTimer = null;
      }
    },
  };
}
