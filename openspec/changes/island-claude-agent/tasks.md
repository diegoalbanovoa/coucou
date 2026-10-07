# Tasks

## 1. Project attach/detach state (Rust)

- [ ] 1.1 Add an `AttachedProject` struct (canonical root path) behind a `Mutex` on app state, with `attach(path)`, `detach()`, `current()`; `attach` canonicalizes the path and fails with an error the caller can surface if canonicalization fails — verify with a unit test covering attach, replace, detach, and a bad-path error
- [ ] 1.2 Add a Tauri command `attach_project` (opens the native folder picker, calls `attach`) and `detach_project` — verify by calling both commands from a scratch TS snippet in dev tools and confirming `current()` reflects each call

## 2. File and command tools confined to the attached project (Rust)

- [ ] 2.1 Implement `resolve_in_project(root, relative_or_absolute) -> Result<PathBuf, ToolError>` that canonicalizes the parent of the target (so a not-yet-existing file is a valid `write_file` target) and rejects anything outside `root` — verify with unit tests: inside path, `..` traversal, absolute path outside root, symlink escape
- [ ] 2.2 Implement `read_file`, `write_file`, `edit_file` (single find-and-replace), `list_dir` tools on top of `resolve_in_project`, each returning a typed success/error result — verify with unit tests per tool covering the success path and the out-of-bounds rejection from 2.1
- [ ] 2.3 Implement the `run_command` tool: spawn via the platform shell with the attached root as CWD, capture combined stdout/stderr up to a size cap, enforce a fixed timeout that returns a timeout `tool_result` rather than hanging — verify with a unit test for a fast command, a test for a command exceeding the size cap (truncated, not panicking), and a test for a command exceeding the timeout
- [ ] 2.4 Wire tool definitions into the request builder so they are included only when a project is attached, and never otherwise (plain Q&A / `web_search`-only request unchanged) — verify with a unit test asserting the request body has no tool entries beyond `web_search` when nothing is attached

## 3. Tool-use execution loop (Rust)

- [ ] 3.1 Extend `claude::send` to branch on `stop_reason == "tool_use"`: for each `tool_use` block, dispatch to the matching tool from §2, append the resulting `tool_result` blocks, and call the API again, repeating until a non-`tool_use` stop reason — verify with a unit test using a stubbed two-round response (tool call, then final text) asserting the final `ChatReply` reflects both rounds
- [ ] 3.2 Make tool dispatch await a permission decision (see §4) before running any tool, and turn a Deny into a `tool_result` with `is_error: true` and an explanation rather than skipping silently — verify with a unit test that a denied call still produces a loop-continuing `tool_result` and the conversation does not stall

## 4. Permission broker for agent-originated tool calls (Rust)

- [ ] 4.1 Add an agent-side counterpart to `pipe::Pending`/`Reply` (or extend the existing one to accept a second origin) keyed the same way, so agent-chat tool calls and hook `PermissionRequest`s share one in-process "is a card currently up" state — verify with a unit test that a second request (either origin) while one is pending is declined immediately, matching the existing hook-vs-hook behavior
- [ ] 4.2 Add the in-memory `Always` remembered-set keyed by `(project_path, tool_name)`, cleared on `detach_project` and never written to disk; exclude the command tool's name from ever being insertable — verify with unit tests: Always recall within a session, cleared on detach, and a direct test that attempting to record Always for the command tool is a no-op
- [ ] 4.3 Emit the permission-card event for an agent-originated request on the same channel/shape `island/hooks.ts` already handles for hook `PermissionRequest`s, and accept the resulting Allow/Deny/Always decision back — verify end-to-end by triggering a tool call in dev mode and confirming the existing card renders with the correct tool/target text

## 5. Island UI — attach control and transcript (TypeScript)

- [ ] 5.1 Add an "Attach project…" chip in the chat header next to the model picker; clicking it with nothing attached opens the folder picker (calls `attach_project`), clicking it while attached shows the folder name and detaches on click — verify manually in `npm run dev` / `tauri dev`: attach, see the chip update, detach, see it revert
- [ ] 5.2 Render tool-activity rows in the chat transcript using the existing `stepLabel`/`approvalTarget`-style "Tool · target" formatting, visually distinct (muted, monospace) from chat bubbles, inserted at the point each tool call resolves — verify manually with a multi-tool-call conversation and confirm the rows appear in order between the relevant bubbles
- [ ] 5.3 Confirm the agent-originated permission card (from 4.3) renders through the existing `State.pendingApproval` card component with no new component needed, including the Always button appearing only for non-command tools — verify manually: trigger a file edit (card shows Allow/Deny/Always) and a command (card shows Allow/Deny only)

## 6. Integration verification

- [ ] 6.1 Run `cargo test` in `windows/src-tauri` and confirm all tests from §1-4 pass
- [ ] 6.2 Run `npm run test` in `windows/` and confirm no regressions in existing chat/hooks tests
- [ ] 6.3 Manual end-to-end pass in `npm run tauri dev`: no project attached → plain chat still works unchanged; attach a scratch folder → ask the agent to read a file, edit it, and run a command, approving each card; detach → confirm the very next message has no tool access; quit and relaunch → confirm Always from the earlier session is not remembered

## Workflow follow-up

- Archive this change once the above verification passes and the user has reviewed the resulting diff.
- Re-run `openspec validate --strict island-claude-agent` before archiving.
