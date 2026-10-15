# Proposal

## Why

Plan v3's Fase 2 asks for an assistant that can act on the PC — search files, read an approved folder, open an app, check the Obsidian vault — reachable from a global shortcut, with per-action approval. Read closely, this is **not** a request to give agent CLIs (`claude`, `gemini`, etc.) more tools: those already have full tool access through the real CLI, and their approval already comes free through Claude Code's own hooks (see the archived `island-claude-agent` change's `OUTCOME.md` for why a second, in-process tool loop for that case was deliberately abandoned — it reimplements a worse version of what the CLI already ships).

What's actually missing is a way to act **without** an agent CLI in the loop at all: the global-shortcut quick assistant, and a provider profile (Fase 1, no tools, no project) that wants a small, closed set of actions. Confirmed with Diego before writing this: this change's tool layer touches neither `agent.rs` nor `consoles.rs`.

## What Changes

- A global keyboard shortcut (configurable; Coucou reports a conflict rather than silently failing to register) that brings the island forward to a lightweight quick-ask input, independent of the chat's own agent-CLI/provider-profile state.
- A **closed, four-action tool list** — no more, each added with its own tests, per the plan's own risk note: `search_files`, `read_approved_folder`, `open_app`, `query_vault`. Nothing else. No write, delete, or execute action at all in this phase; the plan's "aprobación por nivel" read/write split is for a later phase to extend into, not something this change pre-builds unused branches for.
- A new, small in-process permission broker for these tool calls — not a reuse of `pipe::Pending` (that one is keyed to hook-originated requests from an external CLI process; these are Coucou's own, on a different trigger entirely) — surfaced through the same visual approval card the island already shows for hook permission requests, so the user sees one consistent UI regardless of where a request came from.
- `read_approved_folder` is pre-approved (a folder the user explicitly added to an allow-list in settings); every other action, every time, waits for a click — matching the plan's "leer es automático dentro de las carpetas permitidas; escribir, borrar o ejecutar piden un clic" for the one read action this phase has, and erring toward asking for the rest since none of them are reads.
- `query_vault` reuses `vault.rs`'s existing `resolve`/`briefing` — no new vault-access code.
- A local, append-only action log (what ran, when, approved or denied), readable from within the app. Not a chat transcript, not sent anywhere.
- The existing pause switch (`State.paused`, already wired to the tray's "Pause" item and the `set_paused` command, today gating the hook relay) is extended to gate this tool layer too — one flag, not two.
- **BREAKING**: none. Nothing here changes `agent.rs`, `consoles.rs`, or the CLI chat path. A machine with the shortcut unconfigured, or declined, behaves exactly as today.

## Explicitly Out of Scope

- **Agent-CLI tool access** — already complete, already approved through hooks, not touched.
- **Write, delete, or execute actions of any kind.** Four read-ish/launch-ish actions only, per the plan's own "se agrega una herramienta por vez" caution. A write-capable action is a separate, later proposal, not a branch this change leaves half-built.
- **Tool access for an agent-CLI turn triggered by the shortcut.** The shortcut opens a quick-ask using a provider profile (or a fixed default), never routes through `agent::send`.

## Capabilities

### New Capabilities
- `island/quick-assistant`: the global shortcut, its lightweight input, the four-action closed tool list, the new permission broker, the folder allow-list, and the local action log.

### Modified Capabilities
_(none — greenfield OpenSpec project; no archived main specs exist yet. `island/agent-permissions` and `island/agent-session`, from the archived `island-claude-agent` change, were never synced to a main spec — see that change's `OUTCOME.md`.)_

## Impact

- `windows/src-tauri/Cargo.toml`: adds `tauri-plugin-global-shortcut` — a first-party Tauri plugin, the one new dependency this phase's own "sin dependencias de terceros salvo que sea inevitable" rule treats as the inevitable case (there is no way to register an OS-level global hotkey without either this plugin or hand-rolled platform-specific `RegisterHotKey`/equivalent calls, and the plugin is the one Tauri itself maintains for exactly this).
- New `windows/src-tauri/src/quick_assistant.rs`: the four tools, the folder allow-list, the permission broker (a `Pending`-shaped but separate type — seeing design.md for why it isn't the hook relay's own), and the action log.
- `windows/src-tauri/src/lib.rs`: registers the global-shortcut plugin, new Tauri commands for the quick-ask turn, the folder allow-list (add/remove/list), the action log (read), and extends `set_paused` (or the code it already calls) to also gate this tool layer.
- `windows/src-tauri/src/tray.rs`: no change — the existing "Pause" item already does the right thing once the gate check in `quick_assistant.rs` reads the same flag.
- `windows/src/island/`: a new small view for the quick-ask popup, separate from the full chat view, and the approval card extended to show this layer's requests (same visual component, a new source).
- `windows/src/settings/`: a shortcut picker and the folder allow-list editor.
- i18n for every new string.
- No change to `agent.rs`, `agents.rs`, `consoles.rs`, or `providers.rs` beyond providers.rs potentially being the "model" a quick-ask turn uses to decide what to call (read, not modified).
