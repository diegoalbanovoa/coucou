/**
 * The health monitor's events → Mochi's mood and the tab badge. See
 * plan-v2.md § 7.3. Rust decides the level (src-tauri/src/health.rs); this
 * file only ever applies whatever it said. Registered from main.ts.
 */

import { Bridge, onEvent, type HealthEvent } from "../core/bridge";
import { State } from "../core/state";
import { setReducedMotion } from "../mochi/engine";
import { t, fmtPercent } from "../i18n/index";
import type { Island } from "./island";

/** The sentence a tooltip over Mochi reads, once not `ok`. Pure so the
 *  message a mood produces is checkable without a DOM. */
export function healthTooltip(e: HealthEvent): string {
  const cause = t(`health.cause.${e.cause}` as const, { value: fmtPercent(e[e.cause]) });
  return t(`health.mochiSays.${e.level}` as "health.mochiSays.strained" | "health.mochiSays.sick", { cause });
}

/** Mirrors the OS "reduce motion" preference into Mochi's engine, and follows later changes. */
function applyReducedMotionPreference() {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  setReducedMotion(mq.matches);
  mq.addEventListener("change", () => setReducedMotion(mq.matches));
}

/** Starts listening: applies the monitor's last reading right away, then every "health" event. */
export function registerHealthHandlers(island: Island) {
  applyReducedMotionPreference();

  void Bridge.healthState().then((e) => {
    if (e) apply(island, e);
  });

  void onEvent<HealthEvent>("health", (e) => apply(island, e));
}

/** Stores the reading, sets Mochi's mood and tooltip (empty when `ok`), and re-renders. */
function apply(island: Island, e: HealthEvent) {
  State.health = e;
  island.setHealthLevel(e.level);
  island.setHealthTooltip(e.level === "ok" ? "" : healthTooltip(e));
  State.notify();
}
