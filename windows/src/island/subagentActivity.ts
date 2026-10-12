// Subagent activity, tracked from the same live "hook" event the island
// already receives (registerHookHandlers in hooks.ts) — see
// openspec/changes/agent-activity-panel/design.md. Self-contained, like
// views/ticker.ts's Ticker, rather than a field on AppState: easy to test
// and to remove without touching the pill/coucou_agent machinery.

/** One thing a subagent did, newest entries pushed last. */
export interface ActivityEntry {
  action: string;
  at: number;
  result?: string;
}

/** Bounded per agent — a long session must not grow this without limit. */
const MAX_ENTRIES_PER_AGENT = 20;

type Listener = () => void;

class SubagentActivityStore {
  private byAgent = new Map<string, ActivityEntry[]>();
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  /** Distinct agent types seen so far this session, in first-seen order. */
  get agents(): string[] {
    return [...this.byAgent.keys()];
  }

  /** An agent's entries, oldest first. Empty array for an unknown agent. */
  entriesFor(agent: string): ActivityEntry[] {
    return this.byAgent.get(agent) ?? [];
  }

  record(agentType: string, action: string, result?: string) {
    const list = this.byAgent.get(agentType) ?? [];
    list.push({ action, at: Date.now(), result });
    if (list.length > MAX_ENTRIES_PER_AGENT) list.shift();
    this.byAgent.set(agentType, list);
    this.notify();
  }
}

export const SubagentActivity = new SubagentActivityStore();

/** The subset of HookPayload (hooks.ts) this module reads. */
interface SubagentHookPayload {
  agent_type?: string;
  tool_name?: string;
  hook_event_name?: string;
  last_assistant_message?: string;
}

/**
 * Called from registerHookHandlers alongside handleHook, with the same
 * payload — not a second "hook" subscription. The island's test harness
 * (tests/tauri.mjs) backs one listener per event name, so a second
 * independent onEvent("hook", ...) would silently replace the first one
 * instead of adding to it.
 */
export function recordSubagentActivity(payload: SubagentHookPayload) {
  const agentType = payload.agent_type;
  if (!agentType) return;
  const action = payload.tool_name ?? payload.hook_event_name ?? "?";
  const result = payload.hook_event_name === "SubagentStop" ? payload.last_assistant_message : undefined;
  SubagentActivity.record(agentType, action, result);
}
