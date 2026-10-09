// A 32×32 button that is only ever an icon (see docs/plan-v2.md § 1.2).
// `label` is not decorative: it is the only name the button has, so it is
// required and becomes both the tooltip and the accessible name.

import { h } from "../views/dom";
import { icon, type IconName } from "../views/icons";

export interface IconButtonOptions {
  icon: IconName;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}

export function iconButton(opts: IconButtonOptions): HTMLButtonElement {
  return h(
    "button",
    {
      class: "ui-icon-btn",
      "aria-label": opts.label,
      title: opts.label,
      disabled: opts.disabled,
      onclick: opts.onClick,
    },
    icon(opts.icon, { size: 16 }),
  );
}
