// A button in four flavours (see docs/plan-v2.md § 1.2). Every variant keeps
// the same minimum hit target — `--hit-min` for secondary/plain, which sit
// next to other controls, `--hit-primary` for the one action a view actually
// wants pressed.

import { h } from "../views/dom";
import { icon, type IconName } from "../views/icons";

/** Visual weight: `primary` is the one action a view wants pressed. */
export type ButtonVariant = "primary" | "secondary" | "plain" | "destructive";
/** `sm` for dense rows, `md` otherwise. */
export type ButtonSize = "sm" | "md";

/** Options for `button`. At least one of `label` / `icon` should be given. */
export interface ButtonOptions {
  label?: string;
  icon?: IconName;
  /** Defaults to "secondary". */
  variant?: ButtonVariant;
  /** Defaults to "md". */
  size?: ButtonSize;
  disabled?: boolean;
  onClick?: () => void;
}

/** Builds a `.ui-btn` element; styling lives in style.css. Used by views and sheets. */
export function button(opts: ButtonOptions): HTMLButtonElement {
  const variant = opts.variant ?? "secondary";
  const size = opts.size ?? "md";
  return h(
    "button",
    {
      class: `ui-btn ui-btn-${variant} ui-btn-${size}`,
      disabled: opts.disabled,
      onclick: opts.onClick,
    },
    opts.icon ? icon(opts.icon, { size: 14 }) : null,
    opts.label ? h("span", { text: opts.label }) : null,
  );
}
