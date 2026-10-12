# Tasks

> **Punto de retomo (sesión interrumpida)**: el módulo `quick_assistant.rs` existe con las 4 herramientas, las listas de permitidos y el log, todo compilando y con 15 tests en verde — pero **nada está conectado a Tauri todavía** (sin comandos, sin plugin registrado, sin el loop de tool-calling). El siguiente paso concreto es la tarea 4.4: ya se investigó cómo reutilizar la tarjeta de aprobación existente (ver su nota), falta escribirlo. Ver la nota "Plan v3 — Fase 2" en el vault (`Sistema/`) para más contexto de la sesión completa.

## 1. Global shortcut

- [x] 1.1 Added `tauri-plugin-global-shortcut` to `Cargo.toml` (resolved: `tauri-plugin-global-shortcut v2.4.0`, pulling in `global-hotkey`/`keyboard-types`). **Not yet registered in the Tauri builder's `.plugin(...)` chain** — the crate compiles, but nothing calls `tauri_plugin_global_shortcut::init()` yet. `cargo build` clean.
- [ ] 1.2 Settings fields added (`quick_assistant_shortcut: Option<String>` plus `quick_assistant_profile`/`quick_assistant_folders`/`quick_assistant_apps` ahead of schedule, needed by groups 2-6 anyway) — see `settings.rs`. **Still pending**: actually attempting registration on boot and surfacing a conflict.
- [ ] 1.3 Not started (depends on 1.2).

## 2. Allow-lists (folders and apps)

- [x] 2.1 Folder allow-list **logic** done in `quick_assistant.rs`: `is_allowed_path` (canonicalize-both-sides boundary, same shape as `files.rs`'s `inside_inbox`), `add_folder` (refuses a non-directory, dedupes), `remove_folder`. 6 unit tests passing, including a `..`-traversal attempt. **Tauri commands (add/remove/list) not yet written** — these are pure functions `lib.rs` hasn't wired to `remember()`/`shared_settings()` yet.
- [x] 2.2 App allow-list logic done: `add_app` (refuses a non-file, resolves to canonical path, mints an id via `agent::uuid_v4()`), `remove_app`. 2 unit tests passing. **Deviates from the plan as written**: only "pick an executable directly" is implemented — resolving a Start Menu `.lnk` shortcut to its target was dropped for scope; the native file picker can still be pointed at an `.exe` directly. Tauri commands not yet written.

## 3. The four tools (Rust)

- [x] 3.1 `search_files` done — scoped to one allow-listed folder (checked via `is_allowed_path`, not a free-typed path), filename substring match, capped at 50. 3 unit tests passing (inside-folder match, refused when the folder itself isn't allow-listed, cap holds at 60 synthetic files).
- [x] 3.2 `read_approved_folder` done — refuses outright (plain `Err`, no approval path) when outside every allow-listed folder. 2 unit tests passing.
- [x] 3.3 `open_app` done — looks up `app_id` in the allow-list, launches the already-resolved `exe` via `Command::new` with no arguments and no shell. 1 unit test passing (unknown id refused before any launch attempt).
- [x] 3.4 `query_vault` done — thin forward to `vault::resolve`/`vault::briefing`, no new vault code.

## 4. Permission broker + pause gate

- [x] 4.1 **Partial.** The `Pending`/`Decision` types and `next_request_id()` exist in `quick_assistant.rs`, mirroring `pipe::Pending`'s shape. **Not yet wired**: no function actually registers a channel into `Pending`, awaits the response, or times out — `Pending` itself is still "never constructed" per `cargo build`'s own warning. This is the request/response plumbing 6.1's tool-calling loop will need to call into; it was not finished before this checkpoint.
- [ ] 4.2 Not started — depends on 4.1's registration/await function existing.
- [x] 4.3 `refused_while_paused(paused: bool) -> Option<String>` done and tested (2 unit tests) as a pure function. **Not yet wired to the real flag** — `integrations::PAUSED` (confirmed to be the actual shared pause flag both the tray and `handleHook`'s frontend check trace back to; `State.paused` on the TS side and `integrations::PAUSED` on the Rust side are kept in sync by `main.ts`, not two independent flags as design.md's wording implied — no design correction needed, just confirms where to read it from) needs to be the actual argument at each tool's call site, once those call sites exist.
- [ ] 4.4 **Investigated, not implemented.** Found the exact reuse path: `handleHook`'s `PermissionRequest` branch (`island/hooks.ts` line ~349) builds `State.pendingApproval` from `payload.request_id`/`payload.tool_name`/`payload.tool_input` and *only* auto-declines when `isExternalAgent` is true (a `coucou_agent`-tagged payload) — so a quick-assistant request must emit a payload **without** a `coucou_agent` field (else it hits that auto-decline branch meant for other CLIs, not us) to get the real card. Plan: emit on the same `"hook"` event with a `qa-`-prefixed `request_id` (already what `next_request_id()` produces); have `approval_decision`/`approval_ack`/`approval_decline` in `lib.rs` branch on that prefix to route to `quick_assistant::` instead of `pipe::` — meaning **no new frontend command or component is needed at all**, exactly the goal this task states. None of this is written yet.

## 5. Action log

- [x] 5.1 Append-only JSON-lines log done: `LogEntry`, `log_action` (never fails loudly), `recent_log` (caps to the requested count). 1 round-trip unit test (noted in its own comment: shares a real file across test runs, so it only checks the cap, not exact file contents).
- [ ] 5.2 Tauri command and settings-window view not started.

## 6. The quick-ask loop (Rust + frontend)

- [ ] 6.1 A tool-calling request/response cycle against the configured provider profile's endpoint: sends the four tool definitions in the OpenAI `tools` field (which `providers::send`, Fase 1, deliberately never does — this is new, separate request-building code, not an extension of it), loops on `tool_calls` in the response, dispatches to groups 3-4, and continues the conversation with the results until a plain-text reply. Verify: unit test using a synthetic two-round response (one tool call, then a final answer), mirroring `agent.rs`'s own test style for its CLI loop.
- [ ] 6.2 A lightweight quick-ask input view (new, separate from the full chat view), opened by the shortcut, starting blank every time — never pre-filled with whatever was focused before it opened. Verify manually (7.4): confirm no leakage of prior focus/selection into the input.
- [ ] 6.3 "No model configured" message when `quickAssistantProfile` is unset, mirroring the chat's existing "no agent CLI found" messaging style. Verify manually (7.4).

## 7. Verification

- [ ] 7.1 `cargo test` in `windows/src-tauri`: all new tests from groups 1-6 pass, no regressions.
- [ ] 7.2 `npm run test` in `windows/`: no regressions; new i18n keys covered by the existing i18n consistency tests.
- [ ] 7.3 `tsc --noEmit` and `cargo clippy --all-targets`: clean.
- [ ] 7.4 Manual end-to-end, needs a human: register the shortcut (and confirm a conflict is reported, by holding the same combination in another app first); open the quick-ask from another app entirely; approve and deny each of the four tools at least once; confirm `read_approved_folder` inside the allow-list never shows a card; confirm pausing refuses every tool immediately; confirm the action log shows denied/refused entries, not only approved ones; confirm no prior-focus leakage into the blank quick-ask input.

## Workflow follow-up

- Once the tasks above are complete and verified, run `/opsx:archive` to move this change's specs into `openspec/specs/island/quick-assistant/spec.md`.
