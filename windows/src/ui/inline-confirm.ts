// A row's contents, replaced in place by a yes/no question — what Coucou
// uses instead of `confirm()`, which rule 5 of docs/plan-v2.md § 1 bans
// outright. Esc cancels, matching every other dismissable thing in the island.

import { h } from "../views/dom";

export interface InlineConfirmOptions {
  message: string;
  confirmLabel: string;
  /** Defaults to "Never mind" — the wording the System tab's own clean flow
   *  already uses (src/views/system.ts), kept here so this component reads
   *  the same way before Fase 2 routes it through `t()`. */
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  destructive?: boolean;
}

export function inlineConfirm(opts: InlineConfirmOptions): HTMLElement {
  const confirmBtn = h("button", {
    class: `ui-btn ${opts.destructive ? "ui-btn-destructive" : "ui-btn-primary"} ui-btn-sm`,
    text: opts.confirmLabel,
    onclick: opts.onConfirm,
  });
  const cancelBtn = h("button", {
    class: "ui-btn ui-btn-plain ui-btn-sm",
    text: opts.cancelLabel ?? "Never mind",
    onclick: opts.onCancel,
  });
  const el = h(
    "div",
    { class: "ui-inline-confirm", tabindex: 0 },
    h("span", { class: "ui-inline-confirm-msg", text: opts.message }),
    confirmBtn,
    cancelBtn,
  );
  el.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") opts.onCancel();
  });
  // A destructive confirm starts focused on "no" — an Enter that arrives
  // before anyone meant to answer this must never be the one that deletes
  // something. A non-destructive one (which this component also serves, per
  // docs/plan-v2.md § 1.2's generic firma) can safely default to "yes".
  requestAnimationFrame(() => (opts.destructive ? cancelBtn : confirmBtn).focus());
  return el;
}
