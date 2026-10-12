# Proposal

## Why

Claude Code 2.1.296 added `agent_type`/`agent_id` to every hook payload, identifying which subagent (`planificador`, `constructor`, `mecanico`, or any built-in type like `Explore`) is running when a tool event fires. Diego now runs a multi-subagent workflow built around those three custom agents, but Coucou's existing hook handling (`island/hooks.ts`'s `handleHook`) never reads those fields — it only tracks per-CLI pills via the unrelated `coucou_agent` tag (a different, already-shipped mechanism for *other agent CLIs* like Gemini or Codex, set via `coucou-hook.exe --agent <name>`, not for subagents inside one Claude Code session). There is currently no way to see, at a glance, which subagent did what without reading terminal scrollback.

## What Changes

- Extend the `HookPayload` shape in `island/hooks.ts` with optional `agent_type`/`agent_id` fields (present on Claude Code 2.1.296+, absent and tolerated on older hooks).
- Add a small, independent in-memory history of recent subagent activity (agent, action, time, result), fed by the same `"hook"` Tauri event `handleHook` already subscribes to — a separate listener, not a change to the existing `AgentTask`/pill logic.
- Add a section to the existing `system` view (disk-icon tab) that renders this history as one card per distinct `agent_type` seen recently, each with its last action/result.
- **Explicitly out of scope**: no new header tab (confirmed with Diego — this lives inside the existing `system` view, not a 4th tab); no change to `AgentTask`, pills, or the `coucou_agent` multi-CLI feature; no new Tauri command and no new filesystem read. See Impact below for why.
- **BREAKING**: none — purely additive to an existing view; absent fields are tolerated.

## Capabilities

### New Capabilities
- `island/subagent-activity`: tracking and displaying recent Claude Code subagent (Task-tool) activity inside the island's `system` view.

### Modified Capabilities
_(none — greenfield OpenSpec project, like `island-claude-agent`; no archived specs exist yet to modify)_

## Impact

- `windows/src/island/hooks.ts`: extend `HookPayload`, add a small separate subscriber for subagent activity (reuses the existing `onEvent<HookPayload>("hook", ...)` subscription path — does not touch `handleHook`'s pill-routing logic).
- `windows/src/views/system.ts`: new section rendering the activity cards.
- A small new piece of state for the activity history (exact home — a new tiny module vs. a field on `State` — is `design.md`'s call).
- **No Rust/Tauri changes.** Earlier in this same effort, a global Claude Code hook (`~/.claude/hooks/panel-logger.sh`, wired in `~/.claude/settings.json`) was set up to append every `PreToolUse`/`PostToolUse`/`Stop`/`SubagentStop` event to `~/.claude/panel/eventos.jsonl`, for use outside Coucou. Coucou's own panel does **not** read that file: `pipe.rs` already forwards every one of those same events to the frontend live, in real time, through the `"hook"` Tauri event — polling the file would be slower, redundant, and would need a new Tauri fs-read command (and fs-scope entry) for no benefit. The file keeps being written for any other consumer; this change only wires up Coucou's own, already-live path.
