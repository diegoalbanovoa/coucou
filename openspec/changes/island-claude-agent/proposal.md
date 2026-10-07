# Proposal

## Why

Coucou's island already has a "Claude" chat box, but it is a single-turn Q&A client: one `messages.create` call with only Anthropic's hosted `web_search` tool, no client-side tools, and no execution loop (`claude.rs` never branches on `stop_reason == "tool_use"`). The user wants that same tiny chat to do what the real Claude Code CLI does — read and edit files, run shell commands — without leaving the island for a terminal. Today the only place in Coucou that executes anything on the user's behalf is the external hook relay (`pipe.rs`), driven by a *separate* Claude Code process; the island itself has no agent loop and no permission UI for tool calls it originates itself.

## What Changes

- Replace the single-shot `chat::send` call with a real agentic loop: when the response's `stop_reason` is `tool_use`, execute the requested tool(s) locally and continue the conversation with `tool_result` blocks, repeating until `end_turn` (mirrors the Claude Code CLI's own loop).
- Add a small, fixed client-side tool set scoped to one **attached project folder**: `read_file`, `write_file` (create/overwrite), `edit_file` (find-and-replace), `list_dir`, `run_command` (shell, in the attached folder). No tool is reachable until a folder is attached — there is no ambient whole-filesystem access.
- Add an "Attach project…" action to the island (folder picker), reusing the existing drag-and-drop/file-context affordance where it makes sense. Exactly one project is attached at a time; detaching clears tool access immediately.
- Add a permission card for agent tool calls — visually the same card Claude Code's own `PermissionRequest` hook already renders (Allow / Deny / Always), but sourced from the in-process agent loop instead of the named-pipe relay. "Always" is remembered per (project, tool) pair for the session only, never persisted to disk.
- `run_command` always goes through the permission card; there is no "Always allow" fast path for it, even once a project is attached — commands are the one tool class that can affect things outside the attached folder.
- **BREAKING**: none — this only adds capability to an existing, opt-in chat surface. Chat with no project attached behaves exactly as it does today (plain Q&A, `web_search` only).

## Capabilities

### New Capabilities
- `island/agent-session`: the chat-to-agent upgrade — project attach/detach, the client-side tool set, and the tool_use/tool_result execution loop that replaces the current single-shot call.
- `island/agent-permissions`: the Allow/Deny/Always card for agent-originated tool calls, including the session-only "Always" memory and the blanket exception for `run_command`.

### Modified Capabilities
_(none — this is a greenfield OpenSpec project; the existing chat behavior in `claude.rs` is not yet captured as a spec, so `island/agent-session` supersedes it as a new capability rather than a delta)_

## Impact

- `windows/src-tauri/src/claude.rs`: add the execution loop, tool schemas, and tool dispatch; existing single-turn behavior becomes the zero-tools-attached case.
- `windows/src-tauri/src/pipe.rs`: the `Pending`/`Reply` machinery that already brokers Allow/Decline/Decision for hook-originated permission requests is the natural base to extend (or parallel) for agent-originated ones — see `design.md` for which.
- `windows/src/` (TypeScript, no framework): new island view for the permission card reused for agent tool calls, an "Attach project…" entry point, and a way to show tool activity (which file, which command) in the chat transcript.
- `windows/src-tauri/src/secrets.rs`, `settings.rs`: no change expected — this reuses the existing `anthropic-api-key` already required for chat.
- New attack surface: a `run_command` tool executing on the user's machine from a UI the user may treat as "just chat." `design.md` covers the sandboxing and confirmation-fatigue trade-offs in detail.
