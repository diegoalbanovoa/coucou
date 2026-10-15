// A glass pill that says one thing and goes away — the island's only way to
// report something that happened without a view of its own to say it in
// (a rescan's result, a process that refused to end). See plan-v2.md § 1.2.

import { h } from "../views/dom";

/** Colour treatment of a toast. */
export type ToastTone = "neutral" | "success" | "error";

/** Optional button on a toast (e.g. "Undo"). */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

/** Options for `toast`. */
export interface ToastOptions {
  message: string;
  tone?: ToastTone;
  action?: ToastAction;
  /** Milliseconds before it dismisses itself. */
  duration?: number; // default 2500
}

/**
 * Mounts a self-dismissing toast into `container` and returns a function
 * that removes it early — for when the view that asked for it goes away
 * before the timer would have.
 */
export function toast(container: HTMLElement, opts: ToastOptions): () => void {
  const tone = opts.tone ?? "neutral";
  const el = h(
    "div",
    { class: `ui-toast ui-toast-${tone}`, role: "status", "aria-live": "polite" },
    h("span", { text: opts.message }),
    opts.action
      ? h("button", { class: "ui-toast-action", text: opts.action.label, onclick: opts.action.onClick })
      : null,
  );
  container.append(el);

  const remove = () => el.remove();
  const timer = window.setTimeout(remove, opts.duration ?? 2500);
  return () => {
    window.clearTimeout(timer);
    remove();
  };
}
