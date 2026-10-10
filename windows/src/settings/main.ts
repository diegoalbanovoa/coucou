// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "./settings.css";
import { Bridge, onEvent, type HookStatus } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { h, clear } from "../views/dom";
import { t, tn, fmtPercent, setLocale, resolveLocale, type LocaleSetting } from "../i18n/index";
import { segmented } from "../ui/segmented";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

// ── Claude Code section ───────────────────────────────────────────────────────

function claudeSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    {},
    h("h2", {}, statusDot(status.installed), h("span", { text: t("settings.claudeCode.title") })),
    body,
  );

  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    clear(body);
    draw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: t("settings.claudeCode.title") }));
  };

  function draw() {
    body.append(
      h("div", {
        class: "hint",
        text: status.installed ? t("settings.claudeCode.hookedIn") : t("settings.claudeCode.notHookedIn"),
      }),
      h("div", { class: "row" },
        h("label", { text: t("settings.claudeCode.settingsJson") }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: t("settings.claudeCode.relay") }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (!status.hookReady) {
      body.append(h("div", { class: "notice warn", text: t("settings.claudeCode.relayMissing") }));
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? t("settings.claudeCode.reinstall") : t("settings.claudeCode.install"),
      onclick: () => showPreview(true),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = t("settings.claudeCode.relayNotReady");
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: t("settings.claudeCode.uninstallHooks"),
        onclick: () => showPreview(false),
      }));
    }
    body.append(actions);
  }

  async function showPreview(install: boolean) {
    let preview;
    try {
      preview = await Bridge.hooksPreview(install);
    } catch (err) {
      // An unreadable or invalid settings.json stops here rather than being
      // treated as empty and written over.
      clear(body);
      body.append(
        h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
        h("div", { class: "row" }, h("button", {
          text: t("settings.claudeCode.back"),
          onclick: () => { clear(body); draw(); },
        })),
      );
      return;
    }
    if (!preview) return;
    clear(body);
    body.append(
      h("div", {
        class: "hint",
        text: install ? t("settings.claudeCode.previewInstall") : t("settings.claudeCode.previewUninstall"),
      }),
      renderDiff(preview.diff),
      h("div", { class: "row" },
        h("span", { class: "path", text: t("settings.claudeCode.backupLabel", { backup: preview.backup }) }),
      ),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? t("settings.claudeCode.confirmInstall") : t("settings.claudeCode.confirmUninstall"),
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backup = await Bridge.hooksApply(install, preview.fingerprint);
        clear(body);
        body.append(h("div", {
          class: "notice ok",
          text: t("settings.claudeCode.doneMessage", { backup }),
        }));
        window.setTimeout(() => void rebuild(), 2600);
      } catch (err) {
        confirm.disabled = false;
        body.append(h("div", { class: "notice err", text: t("settings.claudeCode.writeError", { error: String(err) }) }));
      }
    });
    body.append(h("div", { class: "row" }, confirm, h("button", {
      text: t("settings.claudeCode.cancel"),
      onclick: () => { clear(body); draw(); },
    })));
  }

  draw();
  return section;
}

// ── Agents section ───────────────────────────────────────────────────────────

/**
 * The agent CLIs on this machine, as Coucou sees them.
 *
 * This replaces the Claude API key and model picker that used to be here. A
 * CLI needs no key, brings the user's own subscription, tools, skills and
 * CLAUDE.md, and reports its tool calls through the hooks so the island can
 * approve them. A key brought a worse agent and a secret to look after.
 */
function agentsSection(): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:8px" });
  const note = h("div", { class: "hint" });
  const rescan = h("button", { text: t("settings.agents.rescan") });

  async function draw() {
    note.textContent = t("settings.agents.looking");
    clear(body);
    const clis = (await Bridge.agentClis()) ?? [];

    if (clis.length === 0) {
      note.textContent = t("settings.agents.noneFound");
      return;
    }
    note.textContent = tn("settings.agents.summary", clis.length);

    for (const cli of clis) {
      body.append(
        h(
          "div",
          { class: "row" },
          statusDot(true),
          h("label", { text: cli.label }),
          h("span", { class: "hint", style: "flex:0 0 auto", text: cli.version || t("settings.agents.versionUnknown") }),
          h("code", { class: "path", text: cli.path }),
        ),
        // The file is the place to add a flag, lengthen a turn, or let the
        // agent reach one more folder. Written on launch; read on every turn.
        h(
          "div",
          { class: "row" },
          h("label", { text: "" }),
          h("span", { class: "hint", style: "flex:0 0 auto", text: t("settings.agents.config") }),
          h("code", { class: "path", text: cli.configPath }),
        ),
      );
    }
  }

  rescan.addEventListener("click", () => void draw());
  void draw();

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("settings.agents.title") })),
    note,
    body,
    h("div", { class: "row" }, rescan),
  );
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
}

/** Built lazily: field labels go through `t()`, and this file's top level
 *  runs before `setLocale()` has read the boot settings. */
function integrationDefs(): IntegrationDef[] {
  const f = (key: string) => t(`settings.integrations.fields.${key}` as Parameters<typeof t>[0]);
  return [
    { id: "integration_stripe", name: "Stripe", color: "#0570DE",
      fields: [{ key: "stripe-api-key", label: f("secretKey"), placeholder: "sk_live_…", secret: true }] },
    { id: "integration_github", name: "GitHub", color: "#F4505E",
      fields: [{ key: "github-token", label: f("token"), placeholder: "ghp_…", secret: true }] },
    { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
      fields: [{ key: "vercel-token", label: f("token"), placeholder: "…", secret: true }] },
    { id: "integration_n8n", name: "n8n", color: "#F29B38",
      fields: [
        { key: "n8n-url", label: f("instanceUrl"), placeholder: "https://n8n.example.com", secret: false },
        { key: "n8n-api-key", label: f("apiKey"), placeholder: "…", secret: true },
      ] },
    { id: "integration_resend", name: "Resend", color: "#22C55E",
      fields: [{ key: "resend-api-key", label: f("apiKey"), placeholder: "re_…", secret: true }] },
    { id: "integration_notion", name: "Notion", color: "#8C8C8C",
      fields: [{ key: "notion-api-key", label: f("integrationToken"), placeholder: "ntn_…", secret: true }] },
    { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
      fields: [{ key: "calcom-api-key", label: f("apiKey"), placeholder: "cal_…", secret: true }] },
  ];
}

const MAX_ACTIVE = 4;

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = t("settings.integrations.pickUpTo", { max: MAX_ACTIVE, used });
  }

  for (const def of integrationDefs()) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      updateNote();
      void save();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? t("settings.integrations.stored") : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: t("settings.integrations.save") });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? t("settings.integrations.stored") : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: field.label }),
          input, saveBtn, dotEl,
        ),
      );
    }

    list.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          h("i", { class: "dot", style: `background:${def.color}` }),
          h("span", { style: "font-size:12.5px", text: def.name }),
        ),
        rows,
      ),
    );
  }

  updateNote();
  // Folded away: these are the one thing here that wants an API key for every
  // service, and they are nobody's first reason to open this window.
  const fold = h("details", { class: "fold" });
  fold.append(
    h("summary", { text: t("settings.integrations.integrationKeys") }),
    h("div", { class: "fold-body" }, note, list),
  );
  return h("section", {}, h("h2", {}, h("span", { text: t("settings.integrations.advanced") })), fold);
}

// ── The chat's folder ────────────────────────────────────────────────────────

/**
 * Where the chat runs when no project has been attached.
 *
 * The resolution is: the project you attached, then this, then nothing — and
 * "nothing" means the chat says so rather than running somewhere you did not
 * pick. A folder set here that has since been deleted is reported, never
 * silently dropped: an unmounted drive is the usual reason.
 */
function chatFolderSection(): HTMLElement {
  const note = h("div", { class: "hint" });
  const where = h("code", { class: "path" });
  const dot = statusDot(false);
  const choose = h("button", { text: t("settings.chatFolder.choose") });
  const forget = h("button", { text: t("settings.chatFolder.clear") });

  async function draw() {
    const state = (await Bridge.chatFolderState()) ?? { path: "", exists: false };
    const set = state.path !== "";

    dot.style.background = !set ? "#6b7079" : state.exists ? "#22c55e" : "#f4505e";
    where.textContent = set ? state.path : "none";
    where.title = state.path;
    choose.textContent = set ? t("settings.chatFolder.chooseAnother") : t("settings.chatFolder.choose");
    forget.style.display = set ? "" : "none";

    note.textContent = !set
      ? t("settings.chatFolder.noneSet")
      : state.exists
        ? t("settings.chatFolder.usedWhenNoProject")
        : t("settings.chatFolder.folderGone");
  }

  choose.addEventListener("click", async () => {
    const picked = await Bridge.pickChatFolder();
    if (picked) await draw();
  });
  forget.addEventListener("click", async () => {
    await Bridge.forgetChatFolder();
    await draw();
  });

  void draw();

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: t("settings.chatFolder.title") })),
    note,
    h("div", { class: "row" }, h("label", { text: t("settings.chatFolder.default") }), where),
    h("div", { class: "row" }, choose, forget),
  );
}

// ── Knowledge base section ───────────────────────────────────────────────────

/**
 * The Obsidian vault the agent may read and write.
 *
 * Obsidian keeps its own list of vaults, so the usual case needs no setting at
 * all. This is here for when that list has none — Obsidian not installed, or
 * notes kept somewhere it has never been pointed at — and for overriding it.
 */
function vaultSection(): HTMLElement {
  const note = h("div", { class: "hint" });
  const where = h("code", { class: "path" });
  const dot = statusDot(false);
  const choose = h("button", { text: t("settings.vault.choose") });
  const forget = h("button", { text: t("settings.vault.useObsidians") });

  async function draw() {
    const info = (await Bridge.vaultState()) ?? { path: "", source: "none" as const, known: 0 };
    const found = info.source !== "none";

    dot.style.background = found ? "#22c55e" : "#f4505e";
    where.textContent = info.path;
    where.title = info.path;
    choose.textContent = found ? t("settings.vault.chooseAnother") : t("settings.vault.choose");
    forget.style.display = info.source === "chosen" && info.known > 0 ? "" : "none";

    note.textContent =
      info.source === "obsidian"
        ? info.known > 1
          ? t("settings.vault.fromObsidianMany", { n: info.known })
          : t("settings.vault.fromObsidian")
        : info.source === "chosen"
          ? t("settings.vault.chosenOverride")
          : t("settings.vault.noneFound");
  }

  choose.addEventListener("click", async () => {
    const picked = await Bridge.pickVault();
    if (picked) await draw();
  });
  forget.addEventListener("click", async () => {
    await Bridge.forgetVault();
    await draw();
  });

  void draw();

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: t("settings.vault.title") })),
    note,
    h("div", { class: "row" }, h("label", { text: t("settings.vault.vault") }), where),
    h("div", { class: "row" }, choose, forget),
  );
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: t("settings.general.mainDisplay") }),
    h("option", { value: "cursor", text: t("settings.general.displayUnderCursor") }),
  );
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  const language = segmented<LocaleSetting>({
    items: [
      { value: "system", label: t("settings.general.languageSystem") },
      { value: "en", label: "English" },
      { value: "es", label: "Español" },
    ],
    value: settings.language,
    size: "sm",
    onChange: (value) => {
      settings.language = value;
      void save();
      // The click already told this window which language it is in; the
      // render() this triggers is what the rest of the page catches up to.
      renderForLocaleChange();
    },
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("settings.general.title") })),
    h("div", { class: "row" },
      h("label", { text: t("settings.general.sound") }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: t("settings.general.autoClose") }),
      autoClose,
      h("span", { class: "hint", text: t("settings.general.autoCloseHint") }),
    ),
    h("div", { class: "row" },
      h("label", { text: t("settings.general.islandLivesOn") }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: t("settings.general.launchAtStartup") }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
    h("div", { class: "row" },
      h("label", { text: t("settings.general.language") }),
      language.el,
    ),
  );
}

// ── Team health section (plan-v2.md § 7.2) ──────────────────────────────────────

function healthSection(): HTMLElement {
  const threshold = h("input", {
    type: "range", min: "50", max: "95", step: "5",
    value: String(settings.healthThreshold),
  }) as HTMLInputElement;
  const thresholdValue = h("span", { class: "hint", text: fmtPercent(settings.healthThreshold) });
  threshold.addEventListener("input", () => {
    settings.healthThreshold = Number(threshold.value);
    thresholdValue.textContent = fmtPercent(settings.healthThreshold);
    void save();
  });

  const diskThreshold = h("input", {
    type: "range", min: "70", max: "98", step: "2",
    value: String(settings.healthDiskThreshold),
  }) as HTMLInputElement;
  const diskThresholdValue = h("span", { class: "hint", text: fmtPercent(settings.healthDiskThreshold) });
  diskThreshold.addEventListener("input", () => {
    settings.healthDiskThreshold = Number(diskThreshold.value);
    diskThresholdValue.textContent = fmtPercent(settings.healthDiskThreshold);
    void save();
  });
  const diskRow = h(
    "div",
    { class: "row", style: settings.healthIncludeDisk ? "" : "display:none" },
    h("label", { text: t("settings.health.diskThreshold") }),
    diskThreshold,
    diskThresholdValue,
  );

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("settings.health.title") })),
    h("div", { class: "row" },
      h("label", { text: t("settings.health.enabled") }),
      toggle(settings.healthEnabled, (v) => { settings.healthEnabled = v; void save(); }),
    ),
    h("div", { class: "row" },
      h("label", { text: t("settings.health.threshold") }),
      threshold,
      thresholdValue,
    ),
    h("div", { class: "row" },
      h("label", { text: t("settings.health.includeDisk") }),
      toggle(settings.healthIncludeDisk, (v) => {
        settings.healthIncludeDisk = v;
        diskRow.style.display = v ? "" : "none";
        void save();
      }),
    ),
    diskRow,
    // `settings.healthNotify` itself already exists (plan-v2.md § 7.2) and
    // defaults on, ready for the day the worsening banner (§ 7.3) is built —
    // see docs/plan-v2-notas.md's Fase 7 section for why that banner was
    // deferred. A toggle with no effect yet is worse than no toggle: this
    // row returns the moment the banner does.
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────

/** Everything render() needs that is worth asking Rust for only once. */
let hookStatus: HookStatus = { installed: false, settingsPath: "", hookPath: "", hookReady: false };
let secretsPresent: Record<string, boolean> = {};

function render() {
  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Coucou" }), h("span", { class: "version", text: version })),
    claudeSection(hookStatus),
    agentsSection(),
    chatFolderSection(),
    vaultSection(),
    generalSection(),
    healthSection(),
    integrationsSection(secretsPresent),
    h("div", { class: "hint", text: t("settings.footer") }),
  );
}

/** The language picker's own `onChange` — the click already updated
 *  `settings.language`, so this only needs to re-read the locale it implies
 *  and draw the page again in it. */
function renderForLocaleChange() {
  setLocale(resolveLocale(settings.language));
  document.documentElement.lang = resolveLocale(settings.language);
  render();
}

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  setLocale(resolveLocale(settings.language));
  document.documentElement.lang = resolveLocale(settings.language);

  hookStatus = (await Bridge.hooksStatus()) ?? hookStatus;

  const keys = [
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  for (const k of keys) secretsPresent[k] = (await Bridge.secretPresent(k)) ?? false;

  render();

  void onEvent<Settings>("settings-changed", (s) => {
    const languageChanged = s.language !== settings.language;
    settings = { ...settings, ...s };
    // Any other field already shows up correctly next time its own section is
    // interacted with; only the language changes what every section reads to
    // render itself in the first place, so only it earns a full re-render.
    if (languageChanged) renderForLocaleChange();
  });
}

void main();
