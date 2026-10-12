# Design

## Context

Three existing pieces this change reuses, and does not duplicate:

- **`pipe::Pending`/`Reply`** (`pipe.rs`) brokers Allow/Decline/Decision for hook-originated `PermissionRequest`s — keyed by a request id, backed by an `mpsc` channel per pending card. It is specifically about events arriving from an external CLI process over the named pipe. See proposal.md for why this change needs its own, separate broker rather than widening that one.
- **`State.paused`** already gates the hook relay (a paused island declines every `PermissionRequest` without showing a card, and ignores every other hook event — see `hooks.test.mjs`'s "a paused island..." tests) and is flipped by the tray's existing "Pause" `MenuItem` and the `set_paused` Tauri command.
- **The no-shell launch pattern** in `open_in_vscode` (`lib.rs`): resolve the target executable directly, pass the path as a separate argument, never build a shell command string from untrusted input. `open_url` similarly restricts itself to `http(s)://` before handing off to `platform::open_url`.

`vault.rs`'s `resolve`/`briefing` are already read-only and already used by the agent-CLI path's own knowledge-base context; `query_vault` calls them unchanged.

`providers.rs` (Fase 1) deliberately never sends an OpenAI `tools` field — see its own design.md's Non-Goals. The quick assistant needs exactly that capability (a model deciding which of the four tools to call), so it is new code in this change, not an extension of `providers::send`.

## Goals / Non-Goals

**Goals:**
- Four tools, reachable without an agent CLI or an attached project.
- One approval UI, reused, regardless of whether a request came from a hook or from this layer.
- A folder allow-list that removes per-call approval for reads inside it, and nothing else gets that shortcut.
- A pause switch that is one flag, not two.

**Non-Goals:**
- Any write, delete, or execute action (proposal.md).
- Touching `agent.rs`/`consoles.rs`/the CLI chat path at all.
- A full agentic loop with an open-ended tool set — this is the opposite of that, on purpose, after `island-claude-agent`'s own experience with the former.
- Searching or reading anywhere outside the folder allow-list (decision 4 below) — there is no filesystem-wide search in this phase.

## Decisions

**1. A new, separate permission broker — not `pipe::Pending` widened.**
A small `quick_assistant::Pending` (same `HashMap<String, mpsc::Sender<Decision>>` shape) keyed and managed entirely inside `quick_assistant.rs`. The frontend's approval card component is reused (it already just renders "tool + target + three buttons" from whatever payload it is handed); only the Rust-side broker is new.
- *Why*: `pipe::Pending`'s keys are minted for hook events arriving over a named pipe from an external CLI process launched by `agent::send`. A quick-assistant call has no CLI, no pipe, no hook event — forcing it through that type would mean either a fake hook payload (confusing, and risks a real hook request colliding with a synthetic one) or loosening `pipe::Pending`'s invariants for a caller it was never designed for.
- *Alternative considered*: generalize `pipe::Pending` to accept either origin, as the abandoned `island-claude-agent` design.md proposed (its own task 4.1). Rejected for the same reason that whole approach was abandoned — see `OUTCOME.md`. A second, small, independent broker is less code than making one broker correct for two unrelated callers.

**2. `tauri-plugin-global-shortcut` — the one new dependency.**
Tauri's own first-party plugin for OS-level global hotkeys. Registering fails loudly (an `Err`) when another app already holds the combination — surfaced to the settings UI, satisfying the spec's "reported, not silent" requirement with no conflict-prediction logic needed.
- *Alternative considered*: hand-rolled `RegisterHotKey` (Windows) / equivalent per platform. Rejected — more code, more platform branching, for a capability the official plugin already provides maintained.

**3. The quick assistant's model is a Fase 1 provider profile, chosen once in settings.**
A new settings field, `quickAssistantProfile: string | null` (a provider profile id). Until set, the shortcut (if registered at all) opens the quick-ask input but every request fails with a clear "no model configured" message, same spirit as the chat's existing "no agent CLI found" state.
- *Why*: reuses Fase 1's profile storage and key handling entirely — no second credential system, no second "which endpoint" config surface.
- *Alternative considered*: let it fall back to an agent CLI if no provider profile is set. Rejected — would blur exactly the boundary proposal.md draws (the shortcut never touches `agent::send`).

**4. `search_files` is scoped to the folder allow-list too, not the whole disk.**
Both `search_files` and `read_approved_folder` share the same allow-list; `search_files` SHALL NOT be given the whole filesystem to search. It still asks every time (per the spec) — the allow-list here bounds what it can *reach*, not whether it needs approval.
- *Why*: an unscoped filesystem search is a bigger information-disclosure surface than the read tool sitting right next to it with an explicit boundary; there is no reason for the two to disagree about where they are allowed to look.
- *Alternative considered*: let `search_files` reach anywhere and rely on approval alone to catch a bad result. Rejected — approval shows a path after the search already ran across the whole disk to find it; the disclosure (what files exist, named what, where) has already happened by the time there's anything to approve.

**5. `open_app` only opens apps from its own allow-list — never an arbitrary model-supplied string.**
A second, small allow-list (distinct from the folder one): entries the user adds by picking an executable or a Start Menu shortcut, resolved the same no-shell way `open_in_vscode` already resolves its own launcher. The model names which allow-listed app to open; it cannot name a path of its own.
- *Why*: the alternative — handing a model's own text output to something that launches it — is exactly the injection shape computer-use guidance warns about, and the plan's own Fase 2 risk note calls out prompt injection by name. Bounding the target set removes the question of whether a given string is safe to launch at all.
- *Alternative considered*: allow any absolute path that exists and is executable. Rejected — "exists and is executable" is not "safe to launch unattended," and makes every approval card a judgment call about an arbitrary path instead of a recognizable app name.

**6. The action log is a local JSON-lines file, not a database.**
One line per call: timestamp, tool, target, outcome (approved / denied / auto-approved / refused-while-paused). Read by a Tauri command that returns the last N entries; no search/filter UI in this phase.
- *Why*: matches the project's existing preference for flat files over embedding a database (`agents.rs`/`providers.rs`/`transcript.rs` are all one-JSON(-lines)-file patterns); nothing about this log needs querying beyond "show me recent activity."

## Risks / Trade-offs

- **[Risk]** A global shortcut is, by definition, reachable from any app, including ones running with elevated privileges or showing sensitive content on screen at the moment it's pressed — the quick-ask window itself must not leak what was focused before it opened. → **Mitigation**: the quick-ask starts on a blank input every time; it is never handed the previously-focused window's content, selection, or title.
- **[Risk]** `tool_calls`-style responses are not formatted identically across every OpenAI-compatible endpoint (naming, whether arguments arrive as a JSON string or already parsed). → **Mitigation**: scope real-endpoint testing to at least one local (Ollama) and one cloud (OpenRouter) target before calling 7.4-equivalent verification done, same as Fase 1's own manual check.
- **[Trade-off]** No "always allow" for `search_files`/`open_app`/`query_vault` means real friction for a tool used often. Accepted deliberately — the spec asks for it, and it is the safer default for a first phase; a later change can propose a session-scoped "Always" the way the abandoned `island-claude-agent` design once sketched, if the friction turns out to matter in practice.

## Migration Plan

Purely additive. No existing data to migrate — the folder allow-list, the app allow-list, and the action log are all new, empty until the user configures them. Rollback is deleting `quick_assistant.rs`, its Tauri commands, the global-shortcut plugin registration, and the settings UI for the two allow-lists and the shortcut picker; `State.paused`'s existing behavior for the hook relay is unaffected either way.
