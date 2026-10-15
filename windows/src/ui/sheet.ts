// A sheet that rises from the bottom of the view it belongs to — never a new
// window, because rule 6 of docs/plan-v2.md § 1 keeps the island one window
// sized to its content. `.ui-sheet` is positioned by its caller (absolute,
// inset to the view's card); this file only draws what is inside it.

import { h } from "../views/dom";
import { icon } from "../views/icons";
import { t } from "../i18n/index";

/** Options for `sheet`. */
export interface SheetOptions {
  title: string;
  body: Node;
  footer?: Node;
  /** Called by the close button and by Esc; the caller removes the sheet. */
  onClose: () => void;
  /** Accessible name of the close button; defaults to the translated "Cancel". */
  closeLabel?: string;
}

/** Builds the sheet dialog and focuses it on the next frame so Esc works at once. */
export function sheet(opts: SheetOptions): HTMLElement {
  const closeBtn = h(
    "button",
    { class: "ui-icon-btn", "aria-label": opts.closeLabel ?? t("common.cancel"), onclick: opts.onClose },
    icon("xmark", { size: 14 }),
  );
  const el = h(
    "div",
    { class: "ui-sheet", role: "dialog", "aria-modal": "true", "aria-label": opts.title },
    h("div", { class: "ui-sheet-head" }, h("b", { class: "ui-sheet-title", text: opts.title }), closeBtn),
    h("div", { class: "ui-sheet-body" }, opts.body),
    opts.footer ? h("div", { class: "ui-sheet-footer" }, opts.footer) : null,
  );
  el.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") opts.onClose();
  });
  el.tabIndex = -1;
  requestAnimationFrame(() => el.focus());
  return el;
}
