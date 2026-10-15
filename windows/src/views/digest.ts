// The routine digest (plan v4, Fase 7): the result of a scheduled routine, shown
// in the island. It never takes the keyboard focus and has no input: the header
// says which routine and when, the body is the text as Markdown with its own
// scroll, the footer copies it or closes the island. A failed run shows the same
// kind of error card the chat does, with the quick assistant's wording.

import { h, clear, copyToClipboard } from "./dom";
import { icon } from "./icons";
import { render } from "./markdown";
import { errorText } from "./quick";
import type { ViewActions, ViewHost } from "./views";
import { State } from "../core/state";
import { button } from "../ui/button";
import { t, fmtRelative } from "../i18n/index";

/**
 * Builds the routine digest view. `sync()` redraws only when
 * `State.lastRoutineResult` changes identity; `actions.collapse()` closes the
 * island from the footer button.
 */
export function buildDigest(actions: ViewActions): ViewHost {
  const title = h("div", { class: "digest-title" });
  const when = h("div", { class: "digest-when" });
  const body = h("div", { class: "digest-text reply" });
  const copy = button({ label: t("digest.copy"), variant: "secondary", size: "sm" });
  const close = button({ label: t("digest.close"), variant: "plain", size: "sm", onClick: () => actions.collapse() });
  const footer = h("div", { class: "digest-footer" }, copy, close);
  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card" }, h("div", { class: "digest-body" }, h("div", { class: "digest-head" }, title, when), body, footer)),
  );

  let shown: unknown = null;
  let copyTimer: number | null = null;

  copy.addEventListener("click", () => {
    const text = State.lastRoutineResult?.text ?? "";
    void copyToClipboard(text).then((done) => {
      copy.textContent = done ? t("chat.copied") : t("chat.copyFailed");
      if (copyTimer != null) window.clearTimeout(copyTimer);
      copyTimer = window.setTimeout(() => {
        copyTimer = null;
        copy.textContent = t("digest.copy");
      }, 1400);
    });
  });

  /** Fills title, time and body from the current result (text, error or empty). */
  function draw() {
    const result = State.lastRoutineResult;
    clear(body);
    if (!result) return;
    title.textContent = result.label;
    when.textContent = fmtRelative(result.at);
    copy.style.display = result.outcome === "done" ? "" : "none";
    if (result.outcome === "error") {
      body.append(
        h(
          "div",
          { class: "reply-error" },
          h("div", { class: "reply-error-head" }, icon("bang", { size: 12 }), h("span", { text: t("digest.failed") })),
          h("div", { class: "reply-error-detail", text: errorText(result.text) }),
        ),
      );
    } else if (result.text.trim() === "") {
      body.append(h("div", { class: "digest-empty", text: t("quick.emptyReply") }));
    } else {
      body.append(render(result.text));
    }
  }

  return {
    el,
    sync() {
      // Rebuilt only when a different result arrives; the relative time is
      // refreshed in place so the view costs nothing while it sits there.
      const result = State.lastRoutineResult;
      if (result !== shown) {
        shown = result;
        draw();
      } else if (result) {
        when.textContent = fmtRelative(result.at);
      }
      if (copyTimer == null) copy.textContent = t("digest.copy");
      close.textContent = t("digest.close");
    },
  };
}
