// The earlier conversation a provider profile gets along with a new prompt
// (providers.rs's `build_messages`). A provider has no session of its own, so
// the visible chat is its only memory.
//
// It includes the turns an agent CLI answered too: the conversation on screen
// is one conversation (docs/plan-v4-notas.md, Fase 2). It does not trim to a
// budget — the Rust side does, in `fit_history`.

import type { ChatMessage } from "./state";

export interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
}

/** `messages` without its last entry — the user message `submit()` has just
 *  pushed, which travels as the prompt itself — keeping only what the model
 *  said and was asked. Failed turns (`error`) are not part of the dialogue. */
export function providerHistory(messages: ChatMessage[]): HistoryEntry[] {
  return messages
    .slice(0, -1)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}
