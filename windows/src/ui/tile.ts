// The one tile both the services grid and (Fase 3) the console picker use.
//
// Extracted from `views/views.ts`'s `buildPill()` without changing a pixel —
// same ".pill"/".pill-badge" CSS, same DOM shape, same hover and badge
// behaviour. What moved is the one thing that made it `buildPill` and not a
// shared component: it used to reach into an `AgentTask` directly. Now the
// caller hands over a face, a name and a colour, and builds the face however
// its own list of things (integration pills, console fichas) builds faces.
//
// See docs/plan-v2.md § 1.2 and § 3.1.

import { h } from "../views/dom";
import { icon, type IconName } from "../views/icons";

export type TileBadge = "approval" | "finished" | "error";

export interface TileOptions {
  /** The 24px face — an animated mini-bot canvas, a still one, whatever the
   *  caller's list is made of. `tile()` never builds one itself. */
  face: Node;
  name: string;
  /** Tints the border, hover background and badge ring. */
  color: string;
  badge?: TileBadge | null;
  onSelect: () => void;
}

const BADGE_COLORS: Record<TileBadge, string> = {
  approval: "#F5A524",
  finished: "#22C55E",
  error: "#F4505E",
};
const BADGE_ICONS: Record<TileBadge, IconName> = { approval: "bang", finished: "check", error: "xmark" };

/** Lightens a hex colour toward white by `amount` (0..1) — used for the label
 *  on hover, where the plain colour alone reads too dim against the tile. */
export function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function tile(opts: TileOptions): HTMLElement {
  const el = h(
    "div",
    { class: "pill", onclick: opts.onSelect },
    opts.face,
    h("span", { class: "lbl", text: opts.name }),
  );
  el.style.borderColor = `${opts.color}24`;
  el.addEventListener("mouseenter", () => {
    el.style.background = `${opts.color}2e`;
    el.style.borderColor = `${opts.color}8c`;
    el.style.boxShadow = `0 2px 10px ${opts.color}59`;
    (el.querySelector(".lbl") as HTMLElement).style.color = lighten(opts.color, 0.3);
  });
  el.addEventListener("mouseleave", () => {
    el.style.background = "";
    el.style.borderColor = `${opts.color}24`;
    el.style.boxShadow = "";
    (el.querySelector(".lbl") as HTMLElement).style.color = "";
  });

  if (opts.badge) {
    const color = BADGE_COLORS[opts.badge];
    const inner = h("i", { style: `background:${color}` }, icon(BADGE_ICONS[opts.badge], { size: 6 }));
    const badgeEl = h("div", { class: "pill-badge" }, inner);
    badgeEl.style.boxShadow = `0 0 4px ${color}99`;
    el.append(badgeEl);
  }
  return el;
}
