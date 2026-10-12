# Design

## Context

Today's chat (`windows/src-tauri/src/claude.rs`) is one `messages.create` call per turn: it keeps multi-turn history (including any `tool_use`/`tool_result` blocks, per its own comment) but nothing ever executes a tool or loops — the only tool offered is Anthropic's hosted `web_search`, which the API resolves server-side. The API key and all execution already live in Rust, never in the webview (`claude.rs` header: "the API key never leaves the Credential Manager, and file bytes never cross the IPC boundary") — this design keeps that boundary.

Separately, `pipe.rs` already brokers a near-identical problem for *external* Claude Code CLI sessions: a `PermissionRequest` comes in over the named pipe, the island shows a card, a human clicks Allow/Deny, the decision goes back. The front end enforces a stricter invariant than the pipe does: `island/hooks.ts` keeps exactly one `State.pendingApproval` at a time and declines anything that arrives while a card is already up, "so a human never stares at request B while request A waits for a decision nobody can give."

## Goals / Non-Goals

**Goals:**
- Reuse the existing permission-card look, the single-pending-approval invariant, and the `stepLabel`/`approvalTarget` "Tool · target" formatting already shown for hook events, rather than inventing a second visual language for the same concept.
- Keep the Rust/webview boundary exactly where it already is: tool execution and the loop live in `claude.rs`, the webview only renders state and emits the user's decision.
- Make "no project attached" the permanent, zero-trust default — every tool definition disappears from the request itself, not just from what the UI exposes.

**Non-Goals:**
- No sandboxing of `run_command` beyond the working-directory confinement the spec requires — it is not a container or a restricted shell; Allow means "this command runs with the user's own permissions," same as a real terminal.
- No persistence of the attached project across restarts, and no persistence of "Always" decisions — both are in-memory only (see Decisions).
- No multi-project or multi-session chat in v1 — one chat, one optional attached folder, same as today's one `Chat` struct.
- No streaming/token-by-token rendering changes — out of scope, orthogonal to this change.

## Decisions

**Loop and tools live in `claude.rs`, not the webview.**
The alternative — having the TS side drive the loop and call back into Rust per tool — would mean every tool result crosses the IPC boundary and the webview has to be trusted to actually complete the loop. Keeping it in Rust matches the existing rationale for keeping the API key there and means the webview's job stays what it already is: render state, forward a click.

**Reuse the single global `pendingApproval` slot — do not give agent-chat its own card.**
`island/hooks.ts` already encodes a deliberate UX rule: only one permission card exists at a time, anywhere in the app, and a second request is declined rather than queued invisibly. Giving agent-chat tool calls a separate slot would let a real Claude Code CLI approval and an agent-chat approval compete for the user's attention from two different cards simultaneously — exactly the confusion that rule exists to prevent. Agent-chat requests go through the same slot and the same decline-on-conflict behavior; from the user's side, "a permission card is open" means the same thing regardless of which surface asked.

**Path confinement by canonicalizing, not by string-prefix matching.**
A naive `path.starts_with(project_root)` check is defeated by `..` segments and symlinks. Every file-tool call canonicalizes its target (for `write_file`, the target's parent directory, since the file may not exist yet) and checks the canonical result is under the canonical, once-resolved-at-attach-time project root.

**"Always" and the attached project are in-memory only, never written to disk.**
Alternative considered: persist the last attached folder in `settings.json` so re-opening Coucou reattaches it automatically. Rejected — this chat can run shell commands; starting every session with zero ambient access and requiring a conscious re-attach is worth the small convenience cost, and it keeps this feature's state out of the same file the Claude Code hook installer already treats carefully (see `CLAUDE.md`: "Never overwrite `~/.claude/settings.json`... write only after the user confirms" — that discipline is easiest to keep if this feature never touches settings files at all).

**`run_command` never gets an "Always" fast path (already in the spec) — enforced where Allow/Deny/Always is decided, not just in the UI.**
If this were only a UI omission, a crafted tool name could still slip through the "Always" remembered-set on the Rust side. The remembered-set lookup itself is keyed by `(project_path, tool_name)` and the command tool's name is excluded from ever being inserted into it, not just hidden from the button row.

**Attach entry point: a chip next to the existing model picker.**
The chat header already has one clickable control (model name) above the input — "Click the model name above the chat box to switch provider and pick a model." Adding "Attach project…" as a second small control in that same header row keeps the chat's one-line header as the single place options live, instead of adding a new settings page or a menu. Once attached, the chip shows the folder name and doubles as the detach control.

**Tool activity renders as compact rows in the transcript, styled like existing step entries.**
`stepLabel`/`approvalTarget` already produce exactly the "Tool · target" strings this needs (`Edit · config.py`, `Bash · npm test`). Reusing that formatting — rendered as small muted rows between chat bubbles — means no new copy style to design or localize, and a user who already reads Claude Code's step list in the island recognizes the same pattern here.

## Risks / Trade-offs

- [Risk] A model-driven `run_command`, once allowed, can still do anything the user's own shell permissions allow inside the attached folder (e.g. delete everything in it) → Mitigation: the card always shows the literal command text (spec requirement), Always is never offered for commands (spec requirement), and the folder is the user's own explicit, single, revocable choice.
- [Risk] A long-running command blocks that chat turn → Mitigation: a fixed timeout (mirroring `pipe.rs`'s existing `DECISION_TIMEOUT` pattern) ends the tool call with a timeout error fed back to the model as a `tool_result`, rather than hanging the UI indefinitely. No mid-run cancel in v1 (see Open Questions).
- [Risk] Sharing the single pending-approval slot means a real Claude Code CLI request can bump an agent-chat request (or vice versa) → Mitigation: this is the existing, already-shipped behavior for two concurrent hook requests; this change does not weaken it, only adds a second possible source into the same rule.
- [Risk] Canonicalizing a path that doesn't exist yet (new file via `write_file`) requires canonicalizing the parent instead of the target → Mitigation: covered explicitly in the Decisions above; a parent that itself doesn't exist is a tool error, not an attempt to create intermediate directories outside the project.

## Migration Plan

Purely additive: the no-project-attached path is byte-for-byte today's behavior, so there is nothing to migrate and no data format changes. Ship behind no flag — the feature is inert until a user attaches a folder, which is itself the opt-in. Rollback is a plain revert; no persisted state (in-memory only, per Decisions) needs cleanup.

## Open Questions

- Should "Attach project…" offer a short recent-folders list, or always open a fresh picker? Either answer fits the spec and the decisions above unchanged — pure polish, deferred to `tasks.md`.
- Should a running `run_command` be cancelable from the card before its timeout elapses? Worth having, but it's additive to the timeout behavior already specified, not a change to it — deferred.
