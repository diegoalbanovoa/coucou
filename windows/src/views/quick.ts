// The quick-ask view: a bare input and the reply, opened by the global
// shortcut (openspec/changes/quick-assistant-tools). It always opens blank —
// it is never handed what was focused or selected before it opened — and it
// keeps no history of its own. Separate from the chat on purpose: it never
// reads or writes `State.agentCli`, `State.selectedProvider` or the chat log.

import { h } from "./dom";
import { icon } from "./icons";
import type { ViewActions, ViewHost } from "./views";
import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import { t } from "../i18n/index";

/** Set while a quick-ask view exists; `resetQuickAsk` is how the shortcut
 *  empties it, including when it is already the view on screen. */
let resetCurrent: (() => void) | null = null;

/** Empties the quick-ask view (input, reply, in-flight request); called by the global shortcut handler in main.ts. */
export function resetQuickAsk() {
  resetCurrent?.();
}

/**
 * Maps a quick-ask error from Rust (`<kind>:<detail>`, possibly prefixed by
 * `Error:`) to localized text; unknown kinds fall back to the endpoint error
 * with the raw detail. Also reused by the digest view for failed routines.
 *
 * `<kind>:<detail>` from Rust -> the message the user reads.
 */
export function errorText(raw: unknown): string {
  const text = String(raw).replace(/^Error:\s*/, "");
  const cut = text.indexOf(":");
  const kind = cut > 0 ? text.slice(0, cut) : "";
  const detail = cut > 0 ? text.slice(cut + 1) : text;
  switch (kind) {
    case "no-model":
      return t("quick.noModel");
    case "invalid-key":
      return t("quick.errInvalidKey");
    case "no-network":
      return t("quick.errNoNetwork");
    case "rate-limited":
      return t("quick.errRateLimited");
    case "loop-guard":
      return detail === "max-rounds" ? t("quick.errTooManyRounds") : t("quick.errLoopGuard");
    default:
      return t("quick.errEndpoint", { detail });
  }
}

/**
 * Builds the quick-ask view. Submitting calls `Bridge.quickAsk`; Enter sends,
 * Escape collapses the island. `generation` discards replies that belong to a
 * request made before a reset.
 */
export function buildQuick(actions: ViewActions): ViewHost {
  const input = h("input", {
    class: "quick-input",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: t("quick.placeholder"),
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: t("quick.send") }, icon("arrowUp", { size: 11 }));
  const bar = h("div", { class: "chat-bar" }, input, send);
  const reply = h("div", { class: "quick-reply" });
  const el = h("div", { class: "view" }, h("div", { class: "card" }, h("div", { class: "quick-body" }, bar, reply)));

  // A reset bumps this, so a reply still in flight for the previous ask is
  // dropped instead of appearing in a view that was just emptied.
  let generation = 0;
  let busy = false;

  /** Shows `text` in the reply area, styled as an error when asked. */
  function show(text: string, isError: boolean) {
    reply.textContent = text;
    reply.classList.toggle("error", isError);
  }

  /** An approval card takes the island over while a tool waits for its click;
   *  once the answer is in, bring the user back to it. */
  function backToQuick() {
    if (State.mode === "expanded" && State.view !== "quick") actions.setView("quick");
  }

  /** Back to a blank, enabled view; invalidates any request in flight. */
  function reset() {
    generation++;
    busy = false;
    input.value = "";
    input.disabled = false;
    show("", false);
  }
  resetCurrent = reset;

  /** Sends the input to the quick assistant and renders the answer or error. */
  async function submit() {
    const prompt = input.value.trim();
    if (!prompt || busy) return;
    // Nothing to send it to: say so here, the same way Rust would, without a
    // round trip.
    if (!State.settings.quickAssistantProfile) {
      show(t("quick.noModel"), true);
      return;
    }
    const mine = ++generation;
    busy = true;
    input.disabled = true;
    show(t("quick.working"), false);
    try {
      const answer = await Bridge.quickAsk(prompt);
      if (mine === generation) {
        show(answer || t("quick.emptyReply"), false);
        backToQuick();
      }
    } catch (err) {
      if (mine === generation) {
        show(errorText(err), true);
        backToQuick();
      }
    } finally {
      if (mine === generation) {
        busy = false;
        input.disabled = false;
        input.focus();
      }
    }
  }

  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      actions.collapse();
    }
  });

  return {
    el,
    sync() {
      input.placeholder = t("quick.placeholder");
      send.title = t("quick.send");
    },
    focus() {
      input.focus();
    },
  };
}
