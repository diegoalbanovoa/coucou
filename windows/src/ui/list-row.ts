// A 32px list row: a leading glyph or avatar, a title with an optional
// subtitle, and a trailing value or control — the shape iOS lists use
// everywhere from Settings to a Mail inbox. See docs/plan-v2.md § 1.2.

import { h } from "../views/dom";

export interface ListRowOptions {
  leading?: Node;
  title: string;
  subtitle?: string;
  trailing?: Node;
  onClick?: () => void;
}

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
