// A small pill of text, for capability badges, status words, and the like.
// See docs/plan-v2.md § 1.2.

import { h } from "../views/dom";
import { icon, type IconName } from "../views/icons";

/** Colour family of a chip. */
export type ChipTone = "neutral" | "accent" | "green" | "red" | "orange";

/** Options for `chip`. */
export interface ChipOptions {
  label: string;
  icon?: IconName;
  /** Defaults to "neutral". */
  tone?: ChipTone;
}

/** Builds a small non-interactive `.ui-chip` badge. */
export function chip(opts: ChipOptions): HTMLElement {
  const tone = opts.tone ?? "neutral";
  return h(
    "span",
    { class: `ui-chip ui-chip-${tone}` },
    opts.icon ? icon(opts.icon, { size: 10 }) : null,
    h("span", { text: opts.label }),
  );
}
