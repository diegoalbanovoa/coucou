# Tasks

## 1. Global shortcut

- [ ] 1.1 Add `tauri-plugin-global-shortcut` to `windows/src-tauri/Cargo.toml` and register it in `lib.rs`. Verify: `cargo build` clean.
- [ ] 1.2 A `quickAssistantShortcut: string | null` setting (default unset — the feature is inactive until configured), read on boot to attempt registration. On failure (already held by another app), surface the error rather than silently not registering. Verify: unit test for the settings round-trip; manual check for the conflict message (needs a real second app holding a hotkey — folded into 7.4).
- [ ] 1.3 A shortcut picker in the settings window, showing the registration error inline when one occurs. Verify manually (7.4).

## 2. Allow-lists (folders and apps)

- [ ] 2.1 A folder allow-list, stored in settings (a list of absolute paths), with add/remove/list Tauri commands. Verify: unit tests for add/remove/dedupe and for "is this path inside some allow-listed folder" (including a `..`-traversal attempt that resolves outside — refused, same shape as the abandoned `island-claude-agent` design's own `resolve_in_project` tests).
- [ ] 2.2 An app allow-list: entries added by picking an executable (native file picker, `.exe` filter) or resolving a Start Menu shortcut to its target, stored as resolved absolute paths — never a user-typed string taken as-is. Verify: unit test that a non-executable or nonexistent path is refused at add-time, not deferred to launch-time.

## 3. The four tools (Rust)

- [ ] 3.1 `search_files(query, folder_id)`: scoped to one allow-listed folder (by its id, not a free-typed path), simple filename/content match, capped result count. Verify: unit tests for a match inside the folder, nothing outside it reachable even if named explicitly, and the cap holding on a large synthetic tree.
- [ ] 3.2 `read_approved_folder(path)`: resolves `path` and confirms it is inside some allow-listed folder before reading; outside it, refuses outright (no approval card — approving wouldn't change where the path is). Verify: unit tests mirroring 3.1's boundary cases.
- [ ] 3.3 `open_app(app_id)`: looks up `app_id` in the app allow-list (2.2) and launches it the same no-shell way `open_in_vscode` already does — never builds a command from a model-supplied string. Verify: unit test that an `app_id` not on the list is refused before any launch attempt.
- [ ] 3.4 `query_vault(question)`: calls `vault::resolve`/`vault::briefing` unchanged, no new vault-access code. Verify: existing `vault.rs` tests unaffected; a thin test confirming this just forwards.

## 4. Permission broker + pause gate

- [ ] 4.1 `quick_assistant::Pending`: the same `HashMap<String, mpsc::Sender<Decision>>` shape as `pipe::Pending`, but its own type, used only by this module's four tools. Verify: unit test that two concurrent calls get independent ids and independent decisions.
- [ ] 4.2 Wire `read_approved_folder` to skip the broker entirely when its target is inside the allow-list (auto-run); the other three always go through it. Verify: covered by 3.1-3.4's own tests plus a dedicated test that `read_approved_folder` inside the allow-list never creates a pending entry.
- [ ] 4.3 Every tool call checks `State`'s pause flag (read via whatever `set_paused`'s existing command already stores) before doing anything else, refusing immediately if paused. Verify: unit test that a paused call never reaches the broker and never runs.
- [ ] 4.4 Emit the quick-assistant's approval request on the same event/shape the island's existing hook-originated approval card renders, so no new frontend component is needed — only a new source feeding the existing one. Verify manually (7.4): a quick-assistant request shows the same card a hook `PermissionRequest` does.

## 5. Action log

- [ ] 5.1 Append-only JSON-lines log (timestamp, tool, target, outcome) at a new path under `config_dir()`, written after every tool call regardless of outcome. Verify: unit tests that a denied and a refused-while-paused call are both logged, not only approved ones.
- [ ] 5.2 A Tauri command returning the last N log entries; a small view in the settings window listing them. Verify manually (7.4).

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
