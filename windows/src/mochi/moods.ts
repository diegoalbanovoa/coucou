// Mochi's health moods — described as data, the way plan-v2.md § 7.4 asks
// for, so `engine.ts` only ever has to interpolate between two of these
// rather than hand-write three slightly different sets of behaviour.
//
// A mood is a *layer*, not a replacement for BotEngine's own state system
// (idle/working/approval/…): it rides on top, the same way the plan
// describes it — "se dibujan el tinte, los párpados, las mejillas... el
// vaivén... la tos". `engine.ts` is the file that actually draws any of this.

export type HealthLevel = "ok" | "strained" | "sick";

export interface Shiver {
  everyMs: number;
  durationMs: number;
  ampPx: number;
  hz: number;
}

export interface MoodParams {
  /** Always a real colour, even at `ok` — `tintAmount` is what makes it
   *  invisible there, so there is never a null to special-case. */
  tint: string;
  tintAmount: number;
  eyeLid: number;
  eyeStyle: "normal" | "tired" | "closedArc";
  eyeLookY: number;
  blinkEveryMs: readonly [number, number];
  breathPeriodScale: number;
  swayAmpPx: number;
  swayHz: number;
  tiltDeg: number;
  sweatEveryMs: number | null;
  sweatDrops: 1 | 2;
  blush: number;
  thermometer: boolean;
  shiver: Shiver | null;
  coughEveryMs: readonly [number, number] | null;
}

export const MOODS: Record<HealthLevel, MoodParams> = {
  ok: {
    tint: "#cfebd2",
    tintAmount: 0,
    eyeLid: 0,
    eyeStyle: "normal",
    eyeLookY: 0,
    blinkEveryMs: [3000, 6000],
    breathPeriodScale: 1,
    swayAmpPx: 0,
    swayHz: 0,
    tiltDeg: 0,
    sweatEveryMs: null,
    sweatDrops: 1,
    blush: 0,
    thermometer: false,
    shiver: null,
    coughEveryMs: null,
  },
  strained: {
    tint: "#cfebd2",
    tintAmount: 0.35,
    eyeLid: 0.4,
    eyeStyle: "tired",
    eyeLookY: 1,
    blinkEveryMs: [5000, 8000],
    breathPeriodScale: 1.4,
    swayAmpPx: 2,
    swayHz: 0.5,
    tiltDeg: 2.5,
    sweatEveryMs: 4000,
    sweatDrops: 1,
    blush: 0,
    thermometer: false,
    shiver: null,
    coughEveryMs: null,
  },
  sick: {
    tint: "#bfe3c4",
    tintAmount: 0.5,
    eyeLid: 0.55,
    eyeStyle: "closedArc",
    eyeLookY: 2,
    blinkEveryMs: [2500, 4000],
    breathPeriodScale: 1.7,
    swayAmpPx: 1.5,
    swayHz: 0.35,
    tiltDeg: 3.5,
    sweatEveryMs: 2500,
    sweatDrops: 2,
    blush: 0.45,
    thermometer: true,
    shiver: { everyMs: 3000, durationMs: 300, ampPx: 0.8, hz: 12 },
    coughEveryMs: [12000, 20000],
  },
};

/** How long a mood blends into the next one. */
export const MOOD_BLEND_MS = 600;

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace("#", ""), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function lerpColor(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const ch = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${ch(ar, br)}${ch(ag, bg)}${ch(ab, bb)}`;
}

const num = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Interpolates every number and colour continuously; a property with no
 * meaningful halfway point (an eye *shape*, whether the thermometer exists
 * at all, the sweat/cough schedules) switches at the midpoint instead of
 * trying to blend two discrete things into a third. `tintAmount` and `blush`
 * already carry the visible part of that crossfade for the eye/face reading
 * as a whole, which is what keeps the switch from reading as a jump.
 */
export function lerpMood(a: MoodParams, b: MoodParams, t: number): MoodParams {
  const clamped = Math.max(0, Math.min(1, t));
  const mid = clamped >= 0.5;
  return {
    tint: lerpColor(a.tint, b.tint, clamped),
    tintAmount: num(a.tintAmount, b.tintAmount, clamped),
    eyeLid: num(a.eyeLid, b.eyeLid, clamped),
    eyeStyle: mid ? b.eyeStyle : a.eyeStyle,
    eyeLookY: num(a.eyeLookY, b.eyeLookY, clamped),
    blinkEveryMs: [num(a.blinkEveryMs[0], b.blinkEveryMs[0], clamped), num(a.blinkEveryMs[1], b.blinkEveryMs[1], clamped)],
    breathPeriodScale: num(a.breathPeriodScale, b.breathPeriodScale, clamped),
    swayAmpPx: num(a.swayAmpPx, b.swayAmpPx, clamped),
    swayHz: num(a.swayHz, b.swayHz, clamped),
    tiltDeg: num(a.tiltDeg, b.tiltDeg, clamped),
    sweatEveryMs: mid ? b.sweatEveryMs : a.sweatEveryMs,
    sweatDrops: mid ? b.sweatDrops : a.sweatDrops,
    blush: num(a.blush, b.blush, clamped),
    thermometer: mid ? b.thermometer : a.thermometer,
    shiver: mid ? b.shiver : a.shiver,
    coughEveryMs: mid ? b.coughEveryMs : a.coughEveryMs,
  };
}

// ── Deterministic randomness ─────────────────────────────────────────────────

/** mulberry32 — a tiny seeded PRNG, so the blink/sweat/cough calendar a test
 *  asserts against is the same calendar a real run would draw, not a fresh
 *  one every time. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MoodTick {
  blink: boolean;
  sweat: boolean;
  cough: boolean;
  /** True for the tick that starts a shiver — the caller owns how long it
   *  then runs, from `mood.shiver.durationMs`. */
  shiver: boolean;
}

/**
 * The ambient calendar a mood keeps while it is active: when the next blink,
 * sweat drop and cough are due. Kept separate from `BotEngine` itself — the
 * engine already has its own idle-blink timer for when no mood is active,
 * and folding a seeded RNG into that delicate, hand-tuned file was a bigger
 * risk than this file being the one new thing an active mood adds.
 */
export class MoodScheduler {
  private rng: () => number;
  private nextBlinkAt = 0;
  private nextSweatAt: number | null = null;
  private nextCoughAt: number | null = null;
  private nextShiverAt: number | null = null;

  constructor(seed = 1) {
    this.rng = mulberry32(seed);
  }

  private inRange([lo, hi]: readonly [number, number]): number {
    return lo + this.rng() * (hi - lo);
  }

  /** Re-seeds every next-time from `mood`'s own ranges — called whenever the
   *  active mood changes, so a mood that just became sick does not wait out
   *  a cough interval it inherited from being merely strained. */
  reset(mood: MoodParams, nowMs: number) {
    this.nextBlinkAt = nowMs + this.inRange(mood.blinkEveryMs);
    this.nextSweatAt = mood.sweatEveryMs != null ? nowMs + mood.sweatEveryMs : null;
    this.nextCoughAt = mood.coughEveryMs != null ? nowMs + this.inRange(mood.coughEveryMs) : null;
    this.nextShiverAt = mood.shiver != null ? nowMs + mood.shiver.everyMs : null;
  }

  /** What is due at `nowMs`, advancing whatever fired to its own next time. */
  tick(mood: MoodParams, nowMs: number): MoodTick {
    let blink = false;
    let sweat = false;
    let cough = false;
    let shiver = false;

    if (nowMs >= this.nextBlinkAt) {
      blink = true;
      this.nextBlinkAt = nowMs + this.inRange(mood.blinkEveryMs);
    }
    if (mood.sweatEveryMs != null && this.nextSweatAt != null && nowMs >= this.nextSweatAt) {
      sweat = true;
      this.nextSweatAt = nowMs + mood.sweatEveryMs;
    }
    if (mood.coughEveryMs != null && this.nextCoughAt != null && nowMs >= this.nextCoughAt) {
      cough = true;
      this.nextCoughAt = nowMs + this.inRange(mood.coughEveryMs);
    }
    if (mood.shiver != null && this.nextShiverAt != null && nowMs >= this.nextShiverAt) {
      shiver = true;
      this.nextShiverAt = nowMs + mood.shiver.everyMs;
    }
    return { blink, sweat, cough, shiver };
  }
}
