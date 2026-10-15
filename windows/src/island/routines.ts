/**
 * The routine scheduler (plan v4, Fase 7). The webview only SCHEDULES — with
 * `setTimeout` and local time, so no time zone is ever computed in Rust — and
 * tells Rust which routine's hour has come; Rust RUNS it (key, tools through
 * `dispatch`, approvals). Nothing here touches a key or a process.
 *
 * No polling: one timer, at most 30 minutes long, and none at all when no
 * routine is switched on. A long sleep (the machine suspended) is caught on
 * waking: a routine that is up to an hour late still runs (D7b), a later one is
 * recorded as missed. Started from main.ts; the digest it opens is views/digest.ts.
 */

import { Bridge, onEvent, type Routine, type RoutineResult } from "../core/bridge";
import { State } from "../core/state";
import type { IslandMode } from "../core/layout";

/** D7b: how late a routine may still run. */
export const LATE_WINDOW_MS = 60 * 60_000;
/** The longest a single timer sleeps, so a drift after a suspension heals. */
export const MAX_SLEEP_MS = 30 * 60_000;
const MIN_SLEEP_MS = 1_000;

/** A routine occurrence: which routine and the local time it falls due. */
export interface Due {
  id: string;
  at: Date;
}

/** `day` (a date) at the routine's "HH:MM", local. Null for a malformed time. */
function atTime(day: Date, time: string): Date | null {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0);
}

/** The next time any switched-on routine comes due, strictly after `now`. */
export function nextDue(routines: Routine[], now: Date): Due | null {
  let best: Due | null = null;
  for (const r of routines) {
    if (!r.enabled) continue;
    for (let offset = 0; offset <= 7; offset++) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      if (!r.days.includes(day.getDay())) continue;
      const at = atTime(day, r.time);
      if (!at || at.getTime() <= now.getTime()) continue;
      if (!best || at.getTime() < best.at.getTime()) best = { id: r.id, at };
      break; // the earliest day for this routine is all that matters
    }
  }
  return best;
}

/** What came due in `(after, upTo]`, oldest first — one entry per routine (its
 *  latest occurrence), so a week of sleep leaves one "missed", not seven. */
export function dueBetween(routines: Routine[], after: Date, upTo: Date): Due[] {
  const out: Due[] = [];
  for (const r of routines) {
    if (!r.enabled) continue;
    for (let back = 0; back <= 7; back++) {
      const day = new Date(upTo.getFullYear(), upTo.getMonth(), upTo.getDate() - back);
      if (!r.days.includes(day.getDay())) continue;
      const at = atTime(day, r.time);
      if (!at || at.getTime() > upTo.getTime()) continue;
      if (at.getTime() <= after.getTime()) break;
      out.push({ id: r.id, at });
      break;
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** D7b: a routine whose hour passed runs if it is no more than 60 minutes late. */
export function shouldRunLate(dueAt: Date, now: Date): boolean {
  return now.getTime() - dueAt.getTime() <= LATE_WINDOW_MS;
}

/** How long to sleep before looking again: until the due time, never more than
 *  30 minutes and never less than a second. */
export function sleepFor(dueAt: Date, now: Date): number {
  return Math.max(MIN_SLEEP_MS, Math.min(dueAt.getTime() - now.getTime(), MAX_SLEEP_MS));
}

/** Whether a digest may open right now: the island is collapsed, nothing waits
 *  for an approval, no chat turn is in flight and Coucou is not paused. */
export function canOpenDigest(s: {
  mode: IslandMode;
  pendingApproval: unknown;
  chatSending: boolean;
  paused: boolean;
}): boolean {
  return s.mode !== "expanded" && !s.pendingApproval && !s.chatSending && !s.paused;
}

/** What the scheduler needs of the island. */
export interface DigestHost {
  alert(view: "digest"): void;
}

/** Opens `digest` now if it may, or leaves it pending until the island is back
 *  to rest. Never takes the keyboard focus: the island only does that for the
 *  chat and the quick-ask input. */
export function showDigest(host: DigestHost) {
  if (!State.lastRoutineResult) return;
  if (!canOpenDigest(State)) {
    State.pendingDigest = true;
    return;
  }
  State.pendingDigest = false;
  // Kept open until dismissed: a digest that closes by itself before it is read
  // is lost (the result also stays in Settings → Routines).
  State.isPinned = true;
  host.alert("digest");
}

/**
 * Starts the scheduler: loads the routines, arms one timer, and listens for
 * "routines-changed", "settings-changed" and "routine-result". Call once.
 */
export function startRoutineScheduler(host: DigestHost) {
  let routines: Routine[] = [];
  /** Everything due up to this instant has been handled; `tick` looks past it. */
  let cursor = new Date();
  let timer: number | null = null;
  /** Guards against a second tick starting while one is still awaiting Rust. */
  let running = false;

  /** Clears the pending timer. */
  function disarm() {
    if (timer != null) window.clearTimeout(timer);
    timer = null;
  }

  /** Sleeps until the next due routine (capped), or does nothing if none is on. */
  function arm() {
    disarm();
    const now = new Date();
    const next = nextDue(routines, now);
    if (!next) return;
    timer = window.setTimeout(() => void tick(), sleepFor(next.at, now));
  }

  /** Re-reads the routine list from Rust. */
  async function reload() {
    routines = (await Bridge.routineList()) ?? [];
  }

  /** Runs (or records as missed) whatever came due since `cursor`, then re-arms. */
  async function tick() {
    disarm();
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const due = dueBetween(routines, cursor, now);
      cursor = now;
      for (const d of due) {
        if (shouldRunLate(d.at, now)) await Bridge.routineRun(d.id).catch(() => undefined);
        else await Bridge.routineMarkMissed(d.id);
      }
    } finally {
      running = false;
      arm();
    }
  }

  /** Something about the routines changed: settle what was already due with the
   *  old list, then start from now with the new one, so a routine created for
   *  an hour already past today does not fire. */
  async function changed() {
    await tick();
    cursor = new Date();
    await reload();
    arm();
  }

  void onEvent<null>("routines-changed", () => void changed());
  void onEvent<unknown>("settings-changed", () => void changed());

  // Every run, scheduled or "Run now" from Settings, ends here.
  void onEvent<RoutineResult>("routine-result", (result) => {
    if (result.outcome !== "done" && result.outcome !== "error") return;
    State.lastRoutineResult = result;
    State.notify();
    showDigest(host);
  });

  // Back to rest after something else had the island: open a waiting digest.
  State.subscribe(() => {
    if (State.pendingDigest && canOpenDigest(State)) showDigest(host);
  });

  void reload().then(arm);
}
