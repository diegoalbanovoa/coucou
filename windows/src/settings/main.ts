// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.
//
// Entry point of the separate settings window (settings.html). Each section is
// a function that returns a `<section>` element and talks to Rust through
// `Bridge`; `render()` rebuilds the whole page, which is only needed when the
// language changes. Changes to `settings` are written immediately with save().

import "./settings.css";
import { Bridge, onEvent, type HookStatus, type Routine, type RoutineResult } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { h, clear } from "../views/dom";
import { t, tn, fmtPercent, fmtRelative, setLocale, resolveLocale, type LocaleSetting } from "../i18n/index";
import { segmented } from "../ui/segmented";
import { inlineConfirm } from "../ui/inline-confirm";
import { takeSettingsIntent, watchSettingsIntent } from "../core/settings-intent";

/** This window's working copy of the settings; every control mutates it and calls save(). */
let settings: Settings = { ...DEFAULT_SETTINGS };
/** App version shown next to the title, from the boot payload. */
let version = "";

/** Mount point of the whole page. */
const root = document.getElementById("settings-root")!;

/** Persists the whole `settings` object through Rust, which also broadcasts `settings-changed` to the island. */
async function save() {
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

/** Switch button that flips its own look immediately and reports the new value. */
function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

/** Small green/red status dot. */
function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:var(${ok ? "--c-green" : "--c-red"})` });
}

/** Renders a unified diff: `+` lines as additions, `-` as deletions, the rest as context. */
function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

/** Set by `claudeSection()`: opens the install diff, as if "Install hooks" were clicked. */
let startHooksInstall: (() => void) | null = null;

// ── Claude Code section ───────────────────────────────────────────────────────

/**
 * Claude Code hooks: shows the install state and, on request, a diff preview
 * of the change to settings.json with the backup path. Nothing is written
 * until the user confirms; Rust checks the preview's fingerprint on apply so
 * the file cannot change between preview and write.
 */
function claudeSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    {},
    h("h2", {}, statusDot(status.installed), h("span", { text: t("settings.claudeCode.title") })),
    body,
  );

  /** Re-reads the hook status after an apply and redraws the section. */
  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    clear(body);
    draw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: t("settings.claudeCode.title") }));
  };

  /** Draws the status rows and the install/uninstall actions. */
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

  /** Shows the diff of installing (or removing) the hooks and a confirm button; errors from Rust are shown instead of the diff. */
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

  // What the island's "Install hooks" button asks for: the same preview the
  // Install button opens, nothing more. The write still waits for the confirm.
  startHooksInstall = () => {
    section.scrollIntoView({ block: "start" });
    if (status.hookReady) void showPreview(true);
  };

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

  /** Lists the detected CLIs (name, version, binary and config paths). */
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
          { class: "agent-card" },
          h(
            "div",
            { class: "agent-head" },
            statusDot(true),
            h("b", { text: cli.label }),
            h("span", { class: "hint", text: cli.version || t("settings.agents.versionUnknown") }),
          ),
          // Two columns, label | value, so a long path wraps inside its own
          // column instead of dropping under the label.
          h(
            "div",
            { class: "agent-grid" },
            h("span", { class: "agent-key", text: t("settings.agents.binary") }),
            h("code", { class: "agent-path", text: cli.path }),
            // The file is the place to add a flag, lengthen a turn, or let the
            // agent reach one more folder. Written on launch; read on every turn.
            h("span", { class: "agent-key", text: t("settings.agents.config") }),
            h("code", { class: "agent-path", text: cli.configPath }),
          ),
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

/** One integration and the secret fields it needs. */
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

/** How many integrations may be active at once (matches the island's pill slots). */
const MAX_ACTIVE = 4;

/**
 * Collapsible integration keys: an on/off switch per integration (capped at
 * MAX_ACTIVE) and a save button per credential. `present` says which secrets
 * are already stored; the secret values themselves are never read back.
 */
function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  /** Refreshes the "pick up to N" counter. */
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
          dotEl.style.background = value ? "var(--c-green)" : "var(--c-red)";
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

  /** Reads the default chat folder from Rust and updates the dot, path and buttons. */
  async function draw() {
    const state = (await Bridge.chatFolderState()) ?? { path: "", exists: false };
    const set = state.path !== "";

    dot.style.background = !set ? "#6b7079" : state.exists ? "var(--c-green)" : "var(--c-red)";
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

  /** Reads the vault state from Rust and shows where it came from (Obsidian's list or a manual choice). */
  async function draw() {
    const info = (await Bridge.vaultState()) ?? { path: "", source: "none" as const, known: 0 };
    const found = info.source !== "none";

    dot.style.background = found ? "var(--c-green)" : "var(--c-red)";
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

// ── Quick assistant section ──────────────────────────────────────────────────

/** The log's outcome strings, as a translation key. */
function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case "approved": return t("quick.settings.outcome.approved");
    case "denied": return t("quick.settings.outcome.denied");
    case "auto-approved": return t("quick.settings.outcome.autoApproved");
    case "refused-paused": return t("quick.settings.outcome.refusedPaused");
    case "flagged-injection": return t("quick.settings.outcome.flaggedInjection");
    case "refused-loop": return t("quick.settings.outcome.refusedLoop");
    case "redacted": return t("quick.settings.outcome.redacted");
    case "refused-sensitive": return t("quick.settings.outcome.refusedSensitive");
    default: return t("quick.settings.outcome.refusedScope");
  }
}

/**
 * The global shortcut, the model it talks to, the two allow-lists, and the log
 * of what it did. Every list change goes through its own Rust command, which
 * validates it (a folder must be a folder, an app a file) before storing it.
 */
function quickSection(): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const dot = statusDot(false);

  /** Fetches shortcut status, profiles, allow-lists and the last 30 log entries, then rebuilds the section. */
  async function draw() {
    const [info, profiles, folders, apps, log] = await Promise.all([
      Bridge.quickShortcutStatus(),
      Bridge.providerList(),
      Bridge.quickFolders(),
      Bridge.quickApps(),
      Bridge.quickLog(30),
    ]);
    clear(body);

    // Shortcut
    const shortcutInput = h("input", {
      type: "text",
      placeholder: t("quick.settings.shortcutPlaceholder"),
      value: info?.shortcut ?? settings.quickAssistantShortcut ?? "",
    }) as HTMLInputElement;
    /** Registers the shortcut (null clears it); Rust reports conflicts through the status. */
    const apply = async (value: string | null) => {
      await Bridge.quickShortcutSet(value);
      await draw();
    };
    const shortcutNote = !info || !info.shortcut
      ? h("div", { class: "hint", text: t("quick.settings.shortcutNone") })
      : info.registered
        ? h("div", { class: "notice ok", text: t("quick.settings.shortcutOk", { shortcut: info.shortcut }) })
        : h("div", {
            class: "notice err",
            text: t("quick.settings.shortcutConflict", { shortcut: info.shortcut, error: info.error ?? "" }),
          });
    dot.style.background = info?.registered ? "var(--c-green)" : "#6b7079";

    // Model
    const select = h("select", {}) as HTMLSelectElement;
    select.append(h("option", { value: "", text: t("quick.settings.profileNone") }));
    for (const p of profiles ?? []) select.append(h("option", { value: p.id, text: p.label }));
    select.value = settings.quickAssistantProfile ?? "";
    const noModel = h("div", { class: "notice warn", role: "status", text: t("quick.settings.noModelWarning") });
    noModel.hidden = !!settings.quickAssistantProfile;
    select.addEventListener("change", () => {
      settings.quickAssistantProfile = select.value || null;
      noModel.hidden = !!settings.quickAssistantProfile;
      void save();
    });

    /** A list of allowed items, each with a Remove button, or the empty hint. */
    const list = (items: { key: string; text: string }[], empty: string, remove: (key: string) => Promise<void>) =>
      h("div", { style: "display:flex;flex-direction:column;gap:6px" },
        ...(items.length === 0
          ? [h("div", { class: "hint", text: empty })]
          : items.map((item) =>
              h("div", { class: "row" },
                h("code", { class: "path", text: item.text, title: item.text }),
                h("button", {
                  text: t("quick.settings.remove"),
                  onclick: async () => { await remove(item.key); await draw(); },
                }),
              ))),
      );

    body.append(
      noModel,
      h("div", { class: "hint", text: t("quick.settings.intro") }),
      h("div", { class: "row" },
        h("label", { text: t("quick.settings.shortcut") }),
        shortcutInput,
        h("button", { class: "primary", text: t("quick.settings.apply"), onclick: () => void apply(shortcutInput.value.trim() || null) }),
        h("button", { text: t("quick.settings.clear"), onclick: () => void apply(null) }),
      ),
      shortcutNote,
      h("div", { class: "row" }, h("label", { text: t("quick.settings.profile") }), select),
      h("div", { class: "hint", text: t("quick.settings.profileHint") }),
      h("div", { class: "row" },
        h("label", { text: t("quick.settings.folders") }),
        h("button", { text: t("quick.settings.addFolder"), onclick: async () => { await Bridge.quickFolderAdd(); await draw(); } }),
      ),
      list((folders ?? []).map((f) => ({ key: f, text: f })), t("quick.settings.noFolders"), (k) => Bridge.quickFolderRemove(k) as Promise<void>),
      h("div", { class: "row" },
        h("label", { text: t("quick.settings.apps") }),
        h("button", { text: t("quick.settings.addApp"), onclick: async () => { await Bridge.quickAppAdd(); await draw(); } }),
      ),
      list((apps ?? []).map((a) => ({ key: a.id, text: `${a.label} — ${a.exe}` })), t("quick.settings.noApps"), (k) => Bridge.quickAppRemove(k) as Promise<void>),
      h("div", { class: "row" },
        h("label", { text: t("quick.settings.log") }),
        h("button", { text: t("quick.settings.refreshLog"), onclick: () => void draw() }),
      ),
      h("div", { style: "display:flex;flex-direction:column;gap:4px" },
        ...((log ?? []).length === 0
          ? [h("div", { class: "hint", text: t("quick.settings.noLog") })]
          : [...(log ?? [])].reverse().map((e) =>
              h("div", { class: "hint" },
                `${new Date(e.at).toLocaleString(resolveLocale(settings.language))} · ${e.tool} · ${e.target} · ${outcomeLabel(e.outcome)}`,
              ))),
      ),
    );
  }

  void draw();

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: t("quick.settings.title") })),
    body,
    skillsBlock(),
  );
}

/**
 * Imported skills: instructions for the quick assistant, nothing more. Only a
 * skill's SKILL.md is ever copied; Rust ignores scripts/ and allowed-tools, and
 * the note below says so. What the last import left out is remembered here for
 * the session only (Rust stores just the file).
 */
function skillsBlock(): HTMLElement {
  const box = h("div", { style: "display:flex;flex-direction:column;gap:8px;margin-top:12px" });
  const leftOut = new Map<string, string[]>();
  let message: HTMLElement | null = null;
  let removingSkill: string | null = null;

  /** Imports a skill via the native picker; on a name clash asks before replacing it. */
  async function doImport(replace: boolean) {
    message = null;
    try {
      const view = await Bridge.skillImport(replace);
      if (view) leftOut.set(view.name, view.ignored);
    } catch (err) {
      const text = String(err).replace(/^Error:\s*/, "");
      if (text.startsWith("exists:")) {
        message = inlineConfirm({
          message: t("settings.skills.replaceConfirm"),
          confirmLabel: t("settings.skills.replace"),
          cancelLabel: t("settings.skills.neverMind"),
          onConfirm: () => void doImport(true),
          onCancel: () => { message = null; void draw(); },
        });
      } else {
        message = h("div", { class: "notice err", text: t("settings.skills.failed", { detail: text }) });
      }
    }
    await draw();
  }

  /** Redraws the skill list with enable switches, ignored-parts notes and remove confirms. */
  async function draw() {
    const skills = (await Bridge.skillList()) ?? [];
    clear(box);
    box.append(
      h("div", { class: "row" },
        h("label", { text: t("settings.skills.title") }),
        h("button", { text: t("settings.skills.import"), onclick: () => void doImport(false) }),
      ),
      h("div", { class: "hint", text: t("settings.skills.note") }),
    );
    if (message) box.append(message);
    if (skills.length === 0) box.append(h("div", { class: "hint", text: t("settings.skills.none") }));
    for (const s of skills) {
      const ignored = leftOut.get(s.name) ?? s.ignored;
      const files = ignored.filter((i) => i !== "allowed-tools");
      const notes: HTMLElement[] = [];
      if (files.length > 0) {
        notes.push(h("div", { class: "hint", text: t("settings.skills.notImported", { list: files.join(", ") }) }));
      }
      if (ignored.includes("allowed-tools")) {
        notes.push(h("div", { class: "hint", text: t("settings.skills.ignoresAllowedTools") }));
      }
      box.append(
        h("div", { style: "display:flex;flex-direction:column;gap:2px" },
          h("div", { class: "row" },
            h("code", { class: "path", text: s.name, title: s.description }),
            toggle(s.enabled, (v) => { void Bridge.skillSetEnabled(s.name, v); }),
            h("button", {
              text: t("settings.skills.remove"),
              onclick: () => { removingSkill = s.name; void draw(); },
            }),
          ),
          ...(removingSkill === s.name
            ? [inlineConfirm({
                message: t("settings.skills.removeConfirm"),
                confirmLabel: t("settings.skills.remove"),
                cancelLabel: t("settings.skills.neverMind"),
                destructive: true,
                onConfirm: async () => { removingSkill = null; await Bridge.skillDelete(s.name); leftOut.delete(s.name); await draw(); },
                onCancel: () => { removingSkill = null; void draw(); },
              })]
            : []),
          h("div", { class: "hint", text: s.description.length > 90 ? `${s.description.slice(0, 89)}…` : s.description }),
          ...notes,
        ),
      );
    }
  }

  void draw();
  return box;
}

// ── Memory section ───────────────────────────────────────────────────────────

/** Max characters of a memory note shown in the list. */
const NOTE_PREVIEW_CHARS = 80;

/** A note, cut to one line's worth for the list. */
function notePreview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > NOTE_PREVIEW_CHARS ? `${flat.slice(0, NOTE_PREVIEW_CHARS - 1)}…` : flat;
}

/**
 * Memory for the provider chat: two switches (both off), the pinned notes and
 * where they live. The summary switch is disabled while the first is off.
 */
function memorySection(): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  let confirming = false;
  let removingNote: string | null = null;

  /** Reloads the notes and storage path, then rebuilds the section. */
  async function draw() {
    const [notes, path] = await Promise.all([Bridge.memoryNotes(), Bridge.memoryPath()]);
    clear(body);

    const summaryRow = h("div", { class: "row" },
      h("label", { text: t("settings.memory.autoSummary") }),
      toggle(settings.memoryAutoSummary, (v) => { settings.memoryAutoSummary = v; void save(); }),
      h("span", { class: "hint", text: t("settings.memory.autoSummaryHint") }),
    );
    if (!settings.memoryEnabled) {
      summaryRow.style.opacity = "0.5";
      summaryRow.style.pointerEvents = "none";
      summaryRow.setAttribute("aria-disabled", "true");
    }

    const list = h("div", { style: "display:flex;flex-direction:column;gap:6px" },
      ...((notes ?? []).length === 0
        ? [h("div", { class: "hint", text: t("settings.memory.none") })]
        : (notes ?? []).map((n) =>
            h("div", { style: "display:flex;flex-direction:column;gap:2px" },
              h("div", { class: "row" },
                h("code", { class: "path", text: notePreview(n.text), title: n.text }),
                h("button", {
                  text: t("settings.memory.remove"),
                  onclick: () => { removingNote = n.id; void draw(); },
                }),
              ),
              ...(removingNote === n.id
                ? [inlineConfirm({
                    message: t("settings.memory.removeConfirm"),
                    confirmLabel: t("settings.memory.remove"),
                    cancelLabel: t("settings.memory.neverMind"),
                    destructive: true,
                    onConfirm: async () => { removingNote = null; await Bridge.memoryDelete(n.id); await draw(); },
                    onCancel: () => { removingNote = null; void draw(); },
                  })]
                : []),
            ))),
    );

    const clearAll = confirming
      ? inlineConfirm({
          message: t("settings.memory.clearConfirm"),
          confirmLabel: t("settings.memory.clearAll"),
          cancelLabel: t("settings.memory.neverMind"),
          destructive: true,
          onConfirm: async () => { confirming = false; await Bridge.memoryClear(); await draw(); },
          onCancel: () => { confirming = false; void draw(); },
        })
      : h("button", {
          text: t("settings.memory.clearAll"),
          onclick: () => { confirming = true; void draw(); },
        });

    body.append(
      h("div", { class: "hint", text: t("settings.memory.intro") }),
      h("div", { class: "row" },
        h("label", { text: t("settings.memory.enabled") }),
        toggle(settings.memoryEnabled, (v) => { settings.memoryEnabled = v; void save(); void draw(); }),
      ),
      summaryRow,
      h("div", { class: "row" }, h("label", { text: t("settings.memory.notes") })),
      ...(!settings.memoryEnabled && (notes ?? []).length > 0
        ? [h("div", { class: "notice warn", role: "status", text: t("settings.memory.notesUnused") })]
        : []),
      list,
      ...((notes ?? []).length > 0 ? [h("div", { class: "row" }, clearAll)] : []),
      h("div", { class: "row" },
        h("label", { text: t("settings.memory.folder") }),
        h("code", { class: "path", text: path ?? "", title: path ?? "" }),
      ),
    );
  }

  void draw();

  return h("section", {}, h("h2", {}, h("span", { text: t("settings.memory.title") })), body);
}

// ── Routines section ─────────────────────────────────────────────────────────

/** The result's outcome, as the words the user reads. */
function routineOutcomeLabel(outcome: string): string {
  switch (outcome) {
    case "done": return t("settings.routines.outcomeDone");
    case "error": return t("settings.routines.outcomeError");
    case "refused-paused": return t("settings.routines.outcomePaused");
    default: return t("settings.routines.outcomeMissed");
  }
}

/** Short weekday names for 0 (Sunday) to 6, in the interface language. 1 Jan
 *  2023 was a Sunday. */
function weekdayNames(): string[] {
  const fmt = new Intl.DateTimeFormat(resolveLocale(settings.language), { weekday: "short" });
  return [0, 1, 2, 3, 4, 5, 6].map((d) => fmt.format(new Date(2023, 0, 1 + d)));
}

/**
 * Scheduled routines: a prompt, a provider profile, a time and some days. They
 * only run while Coucou is open (the webview schedules, Rust runs). The editor
 * is inline, not a window; "tools" is off by default and every action it asks
 * for still shows its approval card.
 */
function routinesSection(): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  let editing: Partial<Routine> | null = null;
  let removing: string | null = null;
  let running: string | null = null;
  let error: string | null = null;

  /** Saves a routine; a validation error from Rust is kept in `error` and shown in the editor. */
  async function persist(routine: Routine) {
    try {
      await Bridge.routineSave(routine);
      error = null;
    } catch (err) {
      error = String(err).replace(/^Error:\s*/, "");
    }
  }

  /** Inline form for the routine in `editing` (new when it has no id). */
  function editor(profiles: { id: string; label: string }[], skills: string[]): HTMLElement {
    const draft = editing!;
    const label = h("input", { type: "text", value: draft.label ?? "", placeholder: t("settings.routines.label") }) as HTMLInputElement;
    const prompt = h("textarea", { rows: "4", placeholder: t("settings.routines.prompt"), class: "routine-prompt" }) as HTMLTextAreaElement;
    prompt.value = draft.prompt ?? "";
    const profile = h("select", {}) as HTMLSelectElement;
    profile.append(h("option", { value: "", text: t("settings.routines.profileNone") }));
    for (const p of profiles) profile.append(h("option", { value: p.id, text: p.label }));
    profile.value = draft.profileId ?? "";
    const time = h("input", { type: "time", value: draft.time ?? "08:00" }) as HTMLInputElement;
    const chosenDays = new Set<number>(draft.days ?? [1, 2, 3, 4, 5]);
    const dayBoxes = weekdayNames().map((name, d) => {
      const box = h("input", { type: "checkbox" }) as HTMLInputElement;
      box.checked = chosenDays.has(d);
      box.addEventListener("change", () => {
        if (box.checked) chosenDays.add(d);
        else chosenDays.delete(d);
      });
      return h("label", { class: "routine-day" }, box, h("span", { text: name }));
    });
    const skill = h("select", {}) as HTMLSelectElement;
    skill.append(h("option", { value: "", text: t("settings.routines.skillNone") }));
    for (const s of skills) skill.append(h("option", { value: s, text: s }));
    skill.value = draft.skill ?? "";
    let tools = draft.tools ?? false;

    const save = async () => {
      await persist({
        id: draft.id ?? "",
        label: label.value,
        prompt: prompt.value,
        profileId: profile.value,
        time: time.value,
        days: [...chosenDays].sort(),
        tools,
        skill: skill.value || null,
        enabled: draft.enabled ?? true,
      });
      if (!error) editing = null;
      await draw();
    };

    return h("div", { style: "display:flex;flex-direction:column;gap:8px" },
      h("div", { class: "row" }, h("label", { text: t("settings.routines.label") }), label),
      prompt,
      h("div", { class: "row" }, h("label", { text: t("settings.routines.profile") }), profile),
      h("div", { class: "row" }, h("label", { text: t("settings.routines.time") }), time),
      h("div", { class: "row" }, h("label", { text: t("settings.routines.days") }), h("div", { class: "routine-days" }, ...dayBoxes)),
      h("div", { class: "row" }, h("label", { text: t("settings.routines.skill") }), skill),
      h("div", { class: "row" },
        h("label", { text: t("settings.routines.tools") }),
        toggle(tools, (v) => { tools = v; }),
      ),
      h("div", { class: "hint", text: t("settings.routines.toolsHint") }),
      ...(error ? [h("div", { class: "notice err", text: error })] : []),
      h("div", { class: "row" },
        h("button", { class: "primary", text: t("settings.routines.save"), onclick: () => void save() }),
        h("button", { text: t("settings.routines.cancel"), onclick: () => { editing = null; error = null; void draw(); } }),
      ),
    );
  }

  /** One line of the recent-results list. */
  function resultLine(r: RoutineResult): HTMLElement {
    return h("div", { class: "hint" },
      `${r.label} · ${routineOutcomeLabel(r.outcome)} · ${fmtRelative(r.at, resolveLocale(settings.language))}`);
  }

  /** Reloads routines, profiles, skills and recent results, then rebuilds the section. */
  async function draw() {
    const [routines, profiles, skills, results] = await Promise.all([
      Bridge.routineList(),
      Bridge.providerList(),
      Bridge.skillList(),
      Bridge.routineResults(10),
    ]);
    clear(body);
    const names = weekdayNames();
    const profileList = (profiles ?? []).map((p) => ({ id: p.id, label: p.label }));
    const enabledSkills = (skills ?? []).filter((s) => s.enabled).map((s) => s.name);

    const rows = (routines ?? []).map((r) => {
      const confirm = removing === r.id
        ? inlineConfirm({
            message: t("settings.routines.removeConfirm"),
            confirmLabel: t("settings.routines.remove"),
            cancelLabel: t("settings.routines.cancel"),
            destructive: true,
            onConfirm: async () => { removing = null; await Bridge.routineDelete(r.id); await draw(); },
            onCancel: () => { removing = null; void draw(); },
          })
        : null;
      return h("div", { style: "display:flex;flex-direction:column;gap:4px" },
        h("div", { class: "row" },
          h("code", { class: "path", text: r.label, title: r.prompt }),
          h("span", { class: "hint", text: `${r.time} · ${r.days.map((d) => names[d]).join(" ")}` }),
          toggle(r.enabled, (v) => { void persist({ ...r, enabled: v }).then(draw); }),
        ),
        h("div", { class: "row" },
          h("button", {
            text: running === r.id ? t("settings.routines.running") : t("settings.routines.runNow"),
            disabled: running !== null,
            onclick: async () => {
              running = r.id;
              await draw();
              try { await Bridge.routineRun(r.id); } catch { /* the result list shows it */ }
              running = null;
              await draw();
            },
          }),
          h("button", { text: t("settings.routines.edit"), onclick: () => { editing = { ...r }; error = null; void draw(); } }),
          h("button", { text: t("settings.routines.remove"), onclick: () => { removing = r.id; void draw(); } }),
        ),
        ...(confirm ? [confirm] : []),
      );
    });

    body.append(
      h("div", { class: "hint", text: t("settings.routines.note") }),
      ...(rows.length === 0 && !editing ? [h("div", { class: "hint", text: t("settings.routines.none") })] : rows),
      ...(editing
        ? [editor(profileList, enabledSkills)]
        : [h("div", { class: "row" }, h("button", {
            text: t("settings.routines.add"),
            onclick: () => { editing = {}; error = null; void draw(); },
          }))]),
      h("div", { class: "row" }, h("label", { text: t("settings.routines.results") })),
      ...((results ?? []).length === 0
        ? [h("div", { class: "hint", text: t("settings.routines.noResults") })]
        : (results ?? []).map(resultLine)),
    );
  }

  void draw();
  // A routine saved or run elsewhere shows up without reopening the window.
  void onEvent<null>("routines-changed", () => void draw());
  void onEvent<RoutineResult>("routine-result", () => void draw());

  return h("section", {}, h("h2", {}, h("span", { text: t("settings.routines.title") })), body);
}

// ── General section ───────────────────────────────────────────────────────────

/** Sound, auto-close delay, display, launch-at-startup and language. */
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

/** Health monitor settings: enable, usage threshold and the optional disk threshold. */
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

/** Rebuilds the whole page from the current `settings` and cached status. */
function render() {
  clear(root);
  const sections = [
    claudeSection(hookStatus),
    agentsSection(),
    chatFolderSection(),
    vaultSection(),
    quickSection(),
    memorySection(),
    routinesSection(),
    generalSection(),
    healthSection(),
    integrationsSection(secretsPresent),
  ];
  root.append(
    h("h1", {}, h("span", { text: "Coucou" }), h("span", { class: "version", text: version })),
    sectionIndex(sections),
    ...sections,
    h("div", { class: "hint", text: t("settings.footer") }),
  );
}

/**
 * A sticky strip of anchors, one per section, named after each section's own
 * heading. Real links, so Tab reaches them and Enter follows them; the click
 * scrolls the page itself because a `#hash` would reload nothing useful here.
 */
function sectionIndex(sections: HTMLElement[]): HTMLElement {
  const nav = h("nav", { class: "section-index", "aria-label": t("settings.agents.jumpTo") });
  sections.forEach((section, i) => {
    section.id = `sec-${i}`;
    const name = section.querySelector("h2 span")?.textContent ?? "";
    nav.append(
      h("a", {
        href: `#sec-${i}`,
        text: name,
        onclick: (e: Event) => {
          e.preventDefault();
          section.scrollIntoView({ behavior: "smooth", block: "start" });
          section.setAttribute("tabindex", "-1");
          section.focus({ preventScroll: true });
        },
      }),
    );
  });
  return nav;
}

/** The language picker's own `onChange` — the click already updated
 *  `settings.language`, so this only needs to re-read the locale it implies
 *  and draw the page again in it. */
function renderForLocaleChange() {
  setLocale(resolveLocale(settings.language));
  document.documentElement.lang = resolveLocale(settings.language);
  render();
}

/** Boot: load settings and version, language, hook status and which secrets exist, render, then follow `settings-changed`. */
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

  // "Install hooks" on the island opens this window asking for the diff.
  if (takeSettingsIntent()) startHooksInstall?.();
  watchSettingsIntent(() => startHooksInstall?.());

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
