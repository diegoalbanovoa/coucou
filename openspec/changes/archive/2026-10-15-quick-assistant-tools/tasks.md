# Tasks

> **Estado**: todas las tareas implementadas salvo 7.4 (prueba manual, pendiente de un humano). Las notas de cada tarea dicen qué se hizo y en qué se desvió del plan.

## 1. Global shortcut

- [x] 1.1 Added `tauri-plugin-global-shortcut` to `Cargo.toml` (resolved: `v2.4.0`) and registered it in the builder: `.plugin(tauri_plugin_global_shortcut::Builder::new().build())` in `lib.rs`. No JS-side capability is needed — registration happens from Rust only.
- [x] 1.2 Settings fields (`quick_assistant_shortcut`, `_profile`, `_folders`, `_apps`) mirrored in the TS `Settings` type and `DEFAULT_SETTINGS`. Registration on boot: `quick_assistant::apply_shortcut`, called from `setup` with the stored shortcut. A bad string or a conflict is recorded in `ShortcutStatus` (never fatal) and logged.
- [x] 1.3 Conflict surfaced: `quick_shortcut_status` / `quick_shortcut_set` commands return `{ shortcut, registered, error }`; the settings window ("Quick assistant" section) shows a red notice naming the shortcut when `registered` is false. Pressing the shortcut emits `quick-ask` to the island, which opens the quick-ask view. **Decision**: while the island is paused, the shortcut opens nothing (same rule as a file drag), rather than un-pausing like the tray's "Open".

## 2. Allow-lists (folders and apps)

- [x] 2.1 Folder allow-list logic in `quick_assistant.rs`: `is_allowed_path` (canonicalize-both-sides boundary, same shape as `files.rs`'s `inside_inbox`), `add_folder`, `remove_folder`; tests include a `..`-traversal attempt. Tauri commands added: `quick_folders`, `quick_folder_add` (opens the native folder picker, validates, stores), `quick_folder_remove`; editor in the settings window.
- [x] 2.2 App allow-list logic: `add_app`, `remove_app`. **Deviates from the plan as written**: only "pick an executable directly" — resolving a Start Menu `.lnk` was dropped for scope. Commands added: `quick_apps`, `quick_app_add` (native file picker, first pick only; label = file stem; new Rust i18n key `ChooseApp` for the dialog title), `quick_app_remove`; editor in the settings window.

## 3. The four tools (Rust)

- [x] 3.1 `search_files` done — scoped to one allow-listed folder (checked via `is_allowed_path`, not a free-typed path), filename substring match, capped at 50. 3 unit tests passing (inside-folder match, refused when the folder itself isn't allow-listed, cap holds at 60 synthetic files).
- [x] 3.2 `read_approved_folder` done — refuses outright (plain `Err`, no approval path) when outside every allow-listed folder. **Small additions during wiring**: a directory is listed (names, capped at 200) instead of erroring, and a file is read up to 64 KiB so one huge file cannot flood the model. Tests cover both.
- [x] 3.3 `open_app` done — looks up `app_id` in the allow-list, launches the already-resolved `exe` via `Command::new` with no arguments and no shell. 1 unit test passing (unknown id refused before any launch attempt).
- [x] 3.4 `query_vault` done — thin forward to `vault::resolve`/`vault::briefing`, no new vault code.

## 4. Permission broker + pause gate

- [x] 4.1 Broker complete in `quick_assistant.rs`: `Reply { Ack, Decision, Decline }`, `Pending`, `request_approval` (registers the channel, emits the card, waits), and `wait_for_reply` — 800 ms for the island's ack, then 108 s for a click (mirroring `pipe.rs`), with anything that is not an explicit Allow (timeout, decline, closed channel) counting as Deny. Tested with `tokio::test` (allow, both timeouts, decline).
- [x] 4.2 `dispatch` (testable, approval injected) and `execute_tool` (real flag and card) run every call in this order: pause gate, allow-list scope, approval, execution; every outcome is logged. `read_approved_folder` inside the allow-list runs with no card (`auto-approved`); `search_files`, `open_app`, `query_vault` ask every time. **Decision**: an out-of-scope target for `search_files`/`open_app` is refused *before* any card (same reasoning as the spec gives for `read_approved_folder`), logged `refused-scope`. The card's "Always" button is read as a single Allow — there is no standing approval in this layer.
- [x] 4.3 `refused_while_paused` is now fed by `integrations::PAUSED` in `execute_tool`, so it applies at every tool's call site (all four go through `dispatch`). Test: all four tools refused with no card and logged `refused-paused`.
- [x] 4.4 Done as planned, no new frontend component or command: `request_approval` emits on the `"hook"` event a `PermissionRequest` payload with no `coucou_agent` and a `qa-` request id; `approval_decision`/`approval_ack`/`approval_decline` in `lib.rs` route on that prefix (`quick_assistant::is_quick_id`) to `quick_assistant::`. The card shows `<tool> · <target>` from `tool_input` (`query` for search, `path` for app/vault). Frontend tests added in `hooks.test.mjs` (a `qa-` request gets the card and the ack; a paused island declines it). Known cosmetic effect: the card goes through the Claude Code pill, as any request without `coucou_agent` does.

## 5. Action log

- [x] 5.1 Append-only JSON-lines log done: `LogEntry`, `log_action` (never fails loudly), `recent_log` (caps to the requested count). 1 round-trip unit test (noted in its own comment: shares a real file across test runs, so it only checks the cap, not exact file contents).
- [x] 5.2 `quick_log` command (newest N, capped at 500) and a "Recent actions" list in the settings window's Quick assistant section, newest first, with outcome labels via i18n (denied and refused entries included). Test-only change to the log: tests now write to a per-process temp file instead of the real log, and each entry is written with one `write_all` so parallel writers cannot fuse two lines.

## 6. The quick-ask loop (Rust + frontend)

- [x] 6.1 New `quick_loop.rs`, separate from `providers::send` (which is untouched; the few error-classification lines are re-implemented there rather than widening its visibility). `tool_definitions()` (exactly four), `parse_completion` (arguments as a JSON string or an object), `run` (HTTP post and tool executor injected; max 6 rounds), `post_completion` (non-streaming, key read from the keychain per request, never stored). Command `quick_ask`. Tests: tool list is exactly the four; both argument shapes; a synthetic two-round exchange (tool call, then final text) checking the tool result goes back with its call id; a runaway loop is cut off.
- [x] 6.2 New `views/quick.ts` (new `quick` island view, registered in `views.ts`/`layout.ts`): one input, one reply area, Enter sends, Esc closes. Opened by the `quick-ask` event; `resetQuickAsk()` empties input and reply every time, and a generation counter drops a late reply to a reset view. It never reads the previous focus or selection, and touches neither `agentCli` nor the chat state. Keyboard focus is taken in `island.ts` the same way the chat does it. After a tool's approval card pulls the island away, the answer brings the view back. The island is pinned while it is open.
- [x] 6.3 "No model configured" (`quick.noModel`, en + es): shown by the view when `quickAssistantProfile` is unset (no round trip), and Rust returns `no-model:` too. Settings has the profile picker (a provider profile from Fase 1). Unit-level only; look and feel is in 7.4.

## 7. Verification

- [x] 7.1 `cargo test` in `windows/src-tauri`: 152 passed, 0 failed (6 ignored, pre-existing).
- [x] 7.2 `npm run test` in `windows/`: 190 passed, 0 failed (includes the i18n consistency and no-hardcoded-strings tests over the new keys).
- [x] 7.3 `tsc --noEmit` clean; `cargo clippy --all-targets` clean (no warnings).
- [x] 7.4 **Pendiente de humano — no hecho por el constructor.** Manual end-to-end, needs a human: register the shortcut (and confirm a conflict is reported, by holding the same combination in another app first); open the quick-ask from another app entirely; approve and deny each of the four tools at least once; confirm `read_approved_folder` inside the allow-list never shows a card; confirm pausing refuses every tool immediately; confirm the action log shows denied/refused entries, not only approved ones; confirm no prior-focus leakage into the blank quick-ask input.

## Workflow follow-up

- Once the tasks above are complete and verified, run `/opsx:archive` to move this change's specs into `openspec/specs/island/quick-assistant/spec.md`.
