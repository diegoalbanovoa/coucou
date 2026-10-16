// A ring gauge — CPU, memory, one drive. See docs/plan-v2.md § 1.2 and § 6.3.
//
// Colour is never the only signal a value is high: from the warning
// threshold up, a "!" badge sits on the ring's edge too, and the caller's
// `ariaLabel` is expected to say the same thing in words ("Memory 76
// percent, high, 11.4 of 15 GB") — this component does not compose that
// sentence itself, since it does not know the units or the locale.

import { h } from "../views/dom";
import { icon } from "../views/icons";
import { t } from "../i18n/index";

/** Ring colour, chosen by `toneFor`. */
export type GaugeTone = "green" | "orange" | "red";

/** Cut-offs (in the gauge's 0..100 scale) between the tones. */
export interface GaugeThresholds {
  /** Value at and above which the ring turns orange. */
  warn: number;
  /** Value at and above which the ring turns red. */
  danger: number;
}

/** CPU and memory: ordinary load, high past 70, critical past 85. */
export const LOAD_THRESHOLDS: GaugeThresholds = { warn: 70, danger: 85 };
/** A drive: unremarkable until it is nearly full — 70% free space used is
 *  normal and must not read as alarming the way 70% memory does. */
export const DISK_THRESHOLDS: GaugeThresholds = { warn: 90, danger: 95 };

/** Maps a value to a tone; at or above `danger` is red, at or above `warn` orange. */
export function toneFor(value: number, thresholds: GaugeThresholds = LOAD_THRESHOLDS): GaugeTone {
  if (value >= thresholds.danger) return "red";
  if (value >= thresholds.warn) return "orange";
  return "green";
}

/** Options for `gauge`. */
export interface GaugeOptions {
  /** 0..100 */
  value: number;
  /** Caption under the ring. */
  label: string;
  /** Smaller second line, e.g. "11.4 of 15 GB". */
  detail: string;
  /** Ring diameter in px; defaults to 64. */
  size?: number;
  /** Defaults to `LOAD_THRESHOLDS`. */
  thresholds?: GaugeThresholds;
  /** The whole reading, in words — see the file note above. */
  ariaLabel: string;
}

const NS = "http://www.w3.org/2000/svg";
const STROKE = 6;

/** Builds the SVG: a grey track plus a rounded arc whose dash offset encodes `pct`. */
function ring(size: number, tone: GaugeTone, pct: number): SVGSVGElement {
  const r = (size - STROKE) / 2;
  const circumference = 2 * Math.PI * r;

  const svg = document.createElementNS(NS, "svg") as SVGSVGElement;
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.classList.add("ui-gauge-svg");
  svg.setAttribute("aria-hidden", "true");

  const track = document.createElementNS(NS, "circle");
  track.setAttribute("cx", String(size / 2));
  track.setAttribute("cy", String(size / 2));
  track.setAttribute("r", String(r));
  track.setAttribute("fill", "none");
  track.setAttribute("stroke", "var(--c-fill-2)");
  track.setAttribute("stroke-width", String(STROKE));

  const arc = document.createElementNS(NS, "circle");
  arc.setAttribute("cx", String(size / 2));
  arc.setAttribute("cy", String(size / 2));
  arc.setAttribute("r", String(r));
  arc.setAttribute("fill", "none");
  arc.setAttribute("stroke", `var(--c-${tone})`);
  arc.setAttribute("stroke-width", String(STROKE));
  arc.setAttribute("stroke-linecap", "round");
  arc.setAttribute("stroke-dasharray", String(circumference));
  arc.setAttribute("stroke-dashoffset", String(circumference * (1 - pct / 100)));
  // 12 o'clock start, clockwise — an unrotated circle starts at 3 o'clock.
  arc.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
  arc.classList.add("ui-gauge-arc");

  svg.append(track, arc);
  return svg;
}

/** Builds a ring gauge with its label and detail; `value` is clamped to 0..100. */
export function gauge(opts: GaugeOptions): HTMLElement {
  const size = opts.size ?? 64;
  const pct = Math.max(0, Math.min(100, opts.value));
  const tone = toneFor(pct, opts.thresholds);

  const value = h("span", { class: "ui-gauge-value", text: String(Math.round(pct)) });
  const center = h("div", { class: "ui-gauge-center" }, value);
  // A badge on the ring's edge, not a stray "!" beside the number. It repeats
  // what the ring colour says, so colour is not the only signal; the reading
  // as a whole is announced by the gauge's own aria-label.
  const warning =
    tone === "green"
      ? null
      : h(
          "span",
          { class: "ui-gauge-warn", title: tone === "red" ? t("system.gaugeBadgeCritical") : t("system.gaugeBadgeHigh"), "aria-hidden": "true" },
          icon("bang", { size: 10 }),
        );

  return h(
    "div",
    { class: `ui-gauge ui-gauge-${tone}`, role: "img", "aria-label": opts.ariaLabel },
    h(
      "div",
      { class: "ui-gauge-ring-wrap", style: `width:${size}px;height:${size}px` },
      ring(size, tone, pct),
      center,
      warning,
    ),
    h("div", { class: "ui-gauge-label", text: opts.label }),
    h("div", { class: "ui-gauge-detail", text: opts.detail }),
  );
}
