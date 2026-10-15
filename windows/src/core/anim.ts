/**
 * Easing + spring helpers.
 * Ease.* mirrors BotEngine.swift `enum Ease` (itself the prototype's `E`).
 * Spring mirrors SwiftUI `.spring(response:dampingFraction:)` so open/close motion
 * matches the macOS app exactly. Used by island/island.ts for the island's
 * size and by mochi/engine.ts for Mochi's motion; all functions are pure and
 * take time as an argument, so nothing here runs a timer of its own.
 */

/** Easing curves on t in [0, 1], mapping to [0, 1] (`back` overshoots past 1). */
export const Ease = {
  /** Cubic ease-out. */
  out: (t: number) => 1 - Math.pow(1 - t, 3),
  /** Cubic ease-in-out. */
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  /** Ease-out with a slight overshoot (c1 = 1.7). */
  back: (t: number) => {
    const c1 = 1.7;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  /** Linear (identity). */
  lin: (t: number) => t,
  /** Cubic ease-in. */
  easeIn: (t: number) => t * t * t,
};

/** Any easing function on [0, 1]. */
export type EaseFn = (t: number) => number;

/** Linear interpolation from `a` to `b`. */
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Pins `v` inside `[lo, hi]`. */
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Progress of `t` through the window `[a, b]`, clamped to 0..1 (for staggered animations). */
export const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a), 0, 1);

/** cubic-bezier(x1,y1,x2,y2) — used for the 340 ms close curve (.45,0,.2,1). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EaseFn {
  const cx = (t: number) => ((1 - t) ** 2 * 3 * t * x1) + (3 * (1 - t) * t * t * x2) + t ** 3;
  const cy = (t: number) => ((1 - t) ** 2 * 3 * t * y1) + (3 * (1 - t) * t * t * y2) + t ** 3;
  return (x) => {
    // Newton-ish bisection on x — 12 iterations is plenty at 60 fps.
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 12; i++) {
      const v = cx(t);
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return cy(t);
  };
}

/** The island's close curve, shared so shrinking always feels the same. */
export const closeCurve = cubicBezier(0.45, 0, 0.2, 1);

/**
 * SwiftUI-equivalent spring: ω₀ = 2π / response, ζ = dampingFraction.
 * Integrated per frame (sub-stepped) so a dropped frame never destabilises it.
 */
export class Spring {
  value: number;
  /** Where the spring is heading; change it and keep calling `step`. */
  target: number;
  velocity = 0;
  /** Natural angular frequency (rad/s), from the response time. */
  omega: number;
  /** Damping ratio; below 1 overshoots. */
  zeta: number;

  /** `response` is the period in seconds, `damping` the SwiftUI damping fraction. */
  constructor(value: number, response = 0.5, damping = 0.72) {
    this.value = value;
    this.target = value;
    this.omega = (2 * Math.PI) / response;
    this.zeta = damping;
  }

  /** Retunes the spring without resetting its position or velocity. */
  configure(response: number, damping: number) {
    this.omega = (2 * Math.PI) / response;
    this.zeta = damping;
  }

  /** Teleports to `value` and stops (no animation). */
  set(value: number) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }

  /** True when close enough to the target, and slow enough, to stop stepping. */
  get settled(): boolean {
    return Math.abs(this.target - this.value) < 0.01 && Math.abs(this.velocity) < 0.05;
  }

  /** Advances by `dt` seconds, sub-stepped at ~240 Hz so long frames stay stable. */
  step(dt: number) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const acc =
        this.omega * this.omega * (this.target - this.value) -
        2 * this.zeta * this.omega * this.velocity;
      this.velocity += acc * h;
      this.value += this.velocity * h;
    }
  }
}

/**
 * Value driven either by a spring (growing) or a timed curve (shrinking) —
 * matches IslandContainer: openSpring for grow, closeEase 340 ms for shrink.
 */
export class Tracked {
  private spring: Spring;
  private curveFrom = 0;
  private curveTo = 0;
  private curveStart = 0;
  private curveDur = 0;
  private mode: "spring" | "curve" | "idle" = "idle";

  constructor(value: number) {
    this.spring = new Spring(value);
  }

  /** Current value. */
  get value(): number {
    return this.spring.value;
  }

  /** True while a spring or curve is still running; callers keep their frame loop alive on it. */
  get animating(): boolean {
    return this.mode !== "idle";
  }

  /** Sets the value immediately, cancelling any animation. */
  jump(v: number) {
    this.spring.set(v);
    this.mode = "idle";
  }

  /** Spring to `v` (open / grow). */
  springTo(v: number, response = 0.5, damping = 0.72) {
    this.spring.configure(response, damping);
    this.spring.target = v;
    this.mode = "spring";
  }

  /** Timed curve to `v` (close / shrink), no overshoot. */
  curveTowards(v: number, durationMs = 340, now = performance.now()) {
    this.curveFrom = this.spring.value;
    this.curveTo = v;
    this.curveStart = now;
    this.curveDur = durationMs;
    this.spring.target = v;
    this.spring.velocity = 0;
    this.mode = "curve";
  }

  /** Advances the active animation; `now` (ms) is only used by curves. Idle is a no-op. */
  step(dt: number, now = performance.now()) {
    if (this.mode === "spring") {
      this.spring.step(dt);
      if (this.spring.settled) {
        this.spring.value = this.spring.target;
        this.spring.velocity = 0;
        this.mode = "idle";
      }
    } else if (this.mode === "curve") {
      const p = clamp((now - this.curveStart) / this.curveDur, 0, 1);
      this.spring.value = lerp(this.curveFrom, this.curveTo, closeCurve(p));
      if (p >= 1) {
        this.spring.velocity = 0;
        this.mode = "idle";
      }
    }
  }
}
