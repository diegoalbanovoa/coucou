// A 32px list row: a leading glyph or avatar, a title with an optional
// subtitle, and a trailing value or control — the shape iOS lists use
// everywhere from Settings to a Mail inbox. See docs/plan-v2.md § 1.2.

import { h } from "../views/dom";

/** Options for `listRow`. */
export interface ListRowOptions {
  /** Glyph or avatar at the start. */
  leading?: Node;
  title: string;
  subtitle?: string;
  /** Value or control at the end. */
  trailing?: Node;
  /** When set, the row becomes clickable and keyboard-focusable. */
  onClick?: () => void;
}

/** Builds a `.ui-row`; only rows with `onClick` get the clickable class and a tabindex. */
export function listRow(opts: ListRowOptions): HTMLElement {
  const text = h(
    "span",
    { class: "ui-row-text" },
    h("b", { class: "ui-row-title", text: opts.title }),
    opts.subtitle ? h("span", { class: "ui-row-subtitle", text: opts.subtitle }) : null,
  );
  return h(
    "div",
    {
      class: opts.onClick ? "ui-row ui-row-clickable" : "ui-row",
      onclick: opts.onClick,
      tabindex: opts.onClick ? 0 : undefined,
    },
    opts.leading ?? null,
    text,
    opts.trailing ?? null,
  );
}
