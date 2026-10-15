# Tasks

## 1. Data layer: track subagent activity from live hook events

- [x] 1.1 In `windows/src/island/hooks.ts`, extend the `HookPayload` interface with optional `agent_type?: string` and `agent_id?: string`. Verify: `tsc --noEmit` passes with no new errors.
- [x] 1.2 Create `windows/src/island/subagentActivity.ts`: a small module holding a `Map<string, ActivityEntry[]>` keyed by `agent_type`, an `ActivityEntry = { action: string; at: number; result?: string }` shape, a capped-push function (max 20 entries per key, FIFO eviction), and its own `subscribe`/`notify` pair (mirrors `views/ticker.ts`'s self-contained style — see design.md Decision 2). Verify: a focused unit test (new `tests/subagentActivity.test.mjs`) covers the 20-entry cap and FIFO eviction for a single key.
- [x] 1.3 **Deviates from the original plan — see note below.** `recordSubagentActivity()` is called from inside `registerHookHandlers`'s existing callback, alongside `handleHook`, rather than via a second `onEvent("hook", ...)` subscription. Verify: `tests/subagentActivity.test.mjs` covers both the present and absent `agent_type` cases, and `tests/hooks.test.mjs`'s existing 53 tests pass unmodified (proves `handleHook`'s own body was not touched) — confirmed, 61/61 passing.
- [x] 1.4 N/A as a separate step — folded into 1.3's single-line change to `registerHookHandlers`. Verify: `git diff` on `hooks.ts` shows exactly a new import line and a 2-line change to `registerHookHandlers`'s callback body; `handleHook`'s own body is untouched.

## 2. View: new "agents" pane in the system view

- [x] 2.1 Added `system.tabAgents`/`system.agentsEmpty` to both `windows/src/i18n/en.ts` and `windows/src/i18n/es.ts`, next to `tabProcesses`/`tabStorage`. Verify: `tsc --noEmit` clean; the project's own "no literal UI string outside src/i18n" lint test (`npm run test`) passes, confirming `t()` usage rather than a hardcoded string.
- [x] 2.2 Extended `type Pane = "processes" | "storage" | "agents"` and added the third `buildSegmented()` item. Verify: `tsc --noEmit` clean. **Not manually verified in a running window** — no GUI available in this environment; see 2.3/2.4 note.
- [x] 2.3 Added `drawAgents()` (parallel to `drawProcesses()`/`drawStorage()`, dispatched from `drawPanel()`), reading `SubagentActivity`'s per-agent entries (newest first, up to 5 older shown per card). Wired a `SubagentActivity.subscribe()` in `focus()`/unsubscribe in `blur()` so the pane redraws live while open, matching the existing `statsTimer`/`procsTimer` lifecycle pattern. **Not manually verified in a running window** — confirmed by `tsc --noEmit` and code review against the exact `drawStorage()` pattern it mirrors, not by clicking through the actual UI.
- [x] 2.4 Empty case reuses the existing `.int-empty` style (same one `consoles.ts`'s empty state uses) with the new `system.agentsEmpty` string. Same verification caveat as 2.2/2.3: not visually confirmed in a running app.

## 3. Verification

- [x] 3.1 `npm run test`: **187/187 passing** (baseline grew from 121 since this memory note was written — includes the 8 new `subagentActivity.test.mjs` tests and the pre-existing 53 `hooks.test.mjs` tests, both passing). No regressions.
- [x] 3.2 `cargo test`: 107 passed, 0 failed, 6 ignored. `cargo clippy --all-targets`: clean, no warnings. `tsc --noEmit`: clean. `git diff --stat -- windows/src-tauri` confirms zero Rust files touched by this change (the one Rust diff present, `system.rs`, predates this change and belongs to unrelated work left uncommitted by another session — not touched here).
- [x] 3.3 **Not done — requires a human.** Manual check: with the global hooks from `~/.claude/settings.json` active, run a Claude Code session in this repo that invokes the `mecanico`, `planificador`, or `constructor` subagent via the `Agent` tool, and confirm its activity appears live in the island's `system` → "agents" pane without restarting Coucou. This needs an actually running Coucou window and a human (or UI-automation tooling not set up here) to look at it — the logic underneath is covered by 3.1/3.2, but seeing the real pane render was not verified.

## Workflow follow-up

- Once tasks above are complete and verified, run `/opsx:archive` to move this change's specs into `openspec/specs/island/subagent-activity/spec.md`.
