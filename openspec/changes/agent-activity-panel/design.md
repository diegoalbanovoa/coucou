# Design

## Context

`windows/src/island/hooks.ts` already subscribes once to the Tauri `"hook"` event (`registerHookHandlers` → `onEvent<HookPayload>("hook", (payload) => handleHook(island, payload))`) and routes every payload into `AgentTask` pills via `handleHook`. That function is the one tested extensively in `windows/tests/hooks.test.mjs` (pill lifecycle, the `coucou_agent` multi-CLI tagging, approval routing, stop timers). `HookPayload` does not currently declare `agent_type`/`agent_id`, the fields Claude Code 2.1.296+ puts on every hook event when it fires inside a subagent.

`windows/src/views/system.ts`'s `buildSystem()` already has a two-value segmented control (`type Pane = "processes" | "storage"`, built by `buildSegmented()`, rendered via `seg.el` next to a `head`/`gaugesRow` that's always visible, with `panel` as the pane-specific content area `drawProcesses()`/`drawPanel()` fill in). See proposal.md - Why / Impact for the motivation and the decision to source this live rather than from `eventos.jsonl`.

## Goals / Non-Goals

**Goals:**
- Show recent subagent activity inside the existing `system` view, live, while Coucou is running.
- Touch `handleHook` and the pill/`coucou_agent` machinery as little as possible — ideally not at all.
- Keep memory bounded for a long-running session.

**Non-Goals:**
- Persisting activity across app restarts (that's what `eventos.jsonl`, written independently by `~/.claude/hooks/panel-logger.sh`, is for — outside Coucou).
- Any change to `AgentTask`, pills, or the `coucou_agent` multi-CLI-pill feature.
- A new header tab (ruled out with Diego already — this is a pane inside `system`, not a 4th tab).
- Showing activity from other machines, other Coucou-tracked CLIs (gemini/codex via `coucou_agent`), or Claude Code's main-conversation turns — subagents only.

## Decisions

**1. A second call inside `registerHookHandlers`'s existing callback, not a branch inside `handleHook`, and not a second `onEvent` registration.**
The original plan for this decision was a fully independent second `onEvent<HookPayload>("hook", ...)` subscription. That turned out not to work with this project's own test harness: `tests/tauri.mjs`'s mock keeps one listener per event name in a `Map` (`listeners.set(args.event, args.handler)`), so a second independent registration on `"hook"` would silently replace the first one in tests, breaking every `hooks.test.mjs` assertion that depends on `handleHook` receiving events. The real Tauri runtime likely supports multiple listeners fine — the constraint is the test double, not Tauri itself — but the implementation has to work under both.

Implemented instead: `registerHookHandlers`'s existing callback now calls `recordSubagentActivity(payload)` right after `handleHook(island, payload)`, both fed the same single `onEvent` registration. `handleHook`'s own body is still untouched — only its two-line wrapper gained a second call.
- *Why*: same rationale as originally — avoid coupling this feature to `handleHook`'s complexity — adjusted for the real constraint. All 53 pre-existing `hooks.test.mjs` tests pass unmodified, confirming `handleHook` itself was never touched.
- *Alternative considered (what was actually tried first)*: a second `onEvent("hook", ...)` call in `subagentActivity.ts`. Rejected after it broke the test harness as described above.
- *Alternative considered*: branch inside `handleHook`. Rejected — couples two unrelated concerns and would require re-verifying every existing `hooks.test.mjs` scenario for a change that doesn't need to touch any of them.

**2. State lives in its own small module, not on the global `AppState`.**
Add a small class/module (`subagentActivity.ts`) owning a `Map<string, ActivityEntry[]>` keyed by `agent_type`, with its own `subscribe`/`notify`, mirroring how `views/ticker.ts`'s `Ticker` is self-contained rather than living on `State`.
- *Why*: `AppState` (`core/state.ts`) is already large and covers concerns (settings, chat, tasks, health...) unrelated to subagent activity; a self-contained module is easier to test in isolation and to delete if this feature is dropped.
- *Alternative considered*: add a `subagentActivity` field directly to `AppState`. Rejected to avoid growing an already-large class with an unrelated concern.

**3. Bounded history: fixed-size ring buffer per agent, count-based.**
Cap each agent's entry list at 20 (matches the spec's minimum guarantee), FIFO eviction — push, then `if (list.length > 20) list.shift()`.
- *Why*: simplest mechanism that satisfies the spec; no timers, no background cleanup pass needed.
- *Alternative considered*: time-based expiry (drop entries older than N minutes). Rejected for v1 — adds a timer and a "what counts as stale" judgment call for no behavior the spec asks for; revisit only if real use shows the count-based cap is wrong.

**4. New `Pane` value `"agents"`, following the existing `processes`/`storage` pattern exactly.**
Extend `type Pane = "processes" | "storage" | "agents"`, add a third `segmented` item (new i18n key, e.g. `system.tabAgents`, added to both locale files the same way `tabProcesses`/`tabStorage` already are), and a `drawAgents()` function parallel to `drawProcesses()`/`drawPanel()`, filling `panel` with one card per `Map` key from the new module.
- *Why*: this is exactly the extension point the view was already built for — a third pane is a one-line addition to an existing union type and segmented-control list, not a new structural concept.
- *Alternative considered*: a card inside the existing `processes` pane instead of a new pane. Rejected — subagent activity is unrelated to OS process/storage data and would clutter that pane's existing list rendering.

**5. Card content**: each card shows the agent name (the `agent_type` string, verbatim — no hardcoded label mapping to `mecanico`/`constructor`/`planificador`, since any subagent type, including Explore/general-purpose/etc., can report), its most recent action/result, and a short scrollable list of earlier entries from its ring buffer (newest first).
- *Why*: verbatim `agent_type` keeps this working for any subagent the user defines later, with zero code changes — consistent with Non-Goal of not hardcoding the three current agent names anywhere in view code.

## Risks / Trade-offs

- **[Risk]** A subagent that runs entirely inside a foreground `Task` call (the common case) finishes before the user ever switches to the `system` view's `agents` pane — the card still shows afterward since this is a running-session history, not just "currently active," but there's no way to tell "finished a minute ago" from "finished an hour ago" without a relative-time label. → **Mitigation**: show the entry's hour (already in the activity data) rather than a bare action name; a relative "hace 2 min" label is a nice-to-have, not required by the spec — leave it to `tasks.md` to decide if it fits this change's size.
- **[Risk]** `agent_type` is absent on hook payloads from a Claude Code version older than 2.1.296 (or from the main conversation, which isn't a subagent at all) — if not filtered correctly, the main conversation's own tool calls could get misattributed to a bogus "agent". → **Mitigation**: the new subscriber ignores any payload where `agent_type` is absent or empty; this is Requirement "Hook events without a subagent identity are tolerated" in the spec, directly testable.
- **[Trade-off]** Because this is live-only (Goal: no disk read), activity from a subagent that ran while Coucou's island was simply not open never appears, even after the island opens later. Accepted per the spec's own "Coucou was not running" scenario — the durable record for that case is `eventos.jsonl`, consumed by something other than Coucou.

## Migration Plan

Purely additive — no existing data model changes, no migration. Rollback is deleting the new module, the new subscriber registration, the new `Pane` value, and the new i18n keys; `handleHook` and `AppState` are never touched, so rollback carries no risk to existing behavior.
