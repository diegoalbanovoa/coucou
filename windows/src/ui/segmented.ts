// An iOS-style segmented control. See docs/plan-v2.md § 1.2.
//
// Keeps its own selected value and redraws itself on click or on ←/→, so a
// caller only has to supply `onChange` — the same shape `buildConsolePanel`
// already uses for its own keyboard handling in views/consoles.ts.

import { h, clear } from "../views/dom";

/** One segment: the value it selects and its visible label. */
export interface SegmentedItem<T extends string> {
  value: T;
  label: string;
}

/** Options for `segmented`. */
export interface SegmentedOptions<T extends string> {
  items: SegmentedItem<T>[];
  /** Initially selected value. */
  value: T;
  /** Fires on user selection only (click or arrow keys). */
  onChange: (value: T) => void;
  /** Defaults to "md". */
  size?: "sm" | "md";
}

/** Handle returned by `segmented`. */
export interface Segmented<T extends string> {
  /** Mount this in the view. */
  el: HTMLElement;
  /** Updates the shown selection without firing `onChange` — for when
   *  something other than a click changed the value (e.g. a setting synced
   *  from the other window). */
  setValue(value: T): void;
}

/** Builds a tablist-style segmented control (roving tabindex, arrows wrap around). */
export function segmented<T extends string>(opts: SegmentedOptions<T>): Segmented<T> {
  const size = opts.size ?? "md";
  let current = opts.value;
  // Roving tabindex, the standard WAI-ARIA tablist pattern: the list itself
  // is never a Tab stop, only the one active tab is — so a two-item control
  // is one stop to reach and ←/→ to move inside, not three stops to Tab
  // through.
  const el = h("div", { class: `ui-segmented ui-segmented-${size}`, role: "tablist" });

  function draw(focusActive = false) {
    clear(el);
    for (const item of opts.items) {
      const on = current === item.value;
      const btn = h("button", {
        class: on ? "ui-segment on" : "ui-segment",
        role: "tab",
        "aria-selected": on ? "true" : "false",
        tabindex: on ? 0 : -1,
        text: item.label,
        onclick: () => select(item.value),
      });
      el.append(btn);
      if (on && focusActive) btn.focus();
    }
  }

  function select(value: T, focusActive = false) {
    if (value === current) return;
    current = value;
    draw(focusActive);
    opts.onChange(value);
  }

  el.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key !== "ArrowLeft" && key !== "ArrowRight") return;
    e.preventDefault();
    const idx = opts.items.findIndex((i) => i.value === current);
    const step = key === "ArrowRight" ? 1 : -1;
    select(opts.items[(idx + step + opts.items.length) % opts.items.length].value, true);
  });

  draw();
  return {
    el,
    setValue(value: T) {
      if (value === current) return;
      current = value;
      draw();
    },
  };
}
