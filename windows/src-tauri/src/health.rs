//! The team's health — a mood for Mochi, not a system state. See
//! plan-v2.md § 7.1.
//!
//! Samples CPU and memory every 2 s (the system drive, only when the user
//! opted in, every 60 s), smooths each with an exponential moving average so
//! one noisy tick cannot swing the reading, and turns the smoothed value into
//! one of three levels with hysteresis: a level is entered only after the
//! metric has held past its threshold for a sustained stretch, and left only
//! after it has held clear of a slightly lower threshold for longer still —
//! which is what keeps Mochi from flickering sick/ok/sick as a build spikes
//! the CPU for a second and lets go.
//!
//! `threshold` (settings, default 70) is the only knob a person turns. Sick's
//! own threshold is never configured directly — it is always `threshold + 15`,
//! which is where plan-v2.md § 7.1's literal "70 enters strained, 85 enters
//! sick" table comes from (70 + 15 = 85), and the same relationship carries
//! through if someone moves the slider. Disk gets its own, independently
//! configured threshold (`diskThreshold`, default 90) and its own hysteresis,
//! composed with the load reading by taking whichever is worse — folding a
//! disk percentage straight into the same 70/85 scale load uses would make an
//! ordinarily-full disk read as "sick" the moment `includeDisk` is switched
//! on, which is exactly the false alarm § 7.1 says disk must not cause.
//!
//! `start` runs the loop (spawned from `lib.rs`) and emits `health` to the
//! island window; `state` serves the last event to a window that just opened.
//! While paused or disabled the loop reads no OS counters.

use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::island::WINDOW_LABEL;
use crate::platform;

/// How often CPU and memory are sampled.
const SAMPLE_EVERY: Duration = Duration::from_secs(2);
/// The drive is read far less often — free space does not move tick to tick,
/// and `platform::drives()` is the heaviest of the three calls this makes.
const DISK_EVERY_TICKS: u32 = 30; // 30 × 2 s = 60 s
/// While not `Ok`, the UI gets a refreshed reading this often even without a
/// level change, so a tooltip showing "76%" is never more than this stale.
const HEARTBEAT_EVERY_SECS: f64 = 10.0;

/// N = 5 samples (~10 s at the 2 s cadence) ⇒ α = 2/(N+1).
const EMA_ALPHA: f64 = 2.0 / 6.0;

/// Seconds a metric must stay past its enter threshold to raise the level.
const ENTER_HOLD_SECS: f64 = 10.0;
/// Seconds a metric must stay clear of its exit threshold to lower the level;
/// longer than entering so the mood does not flicker.
const EXIT_HOLD_SECS: f64 = 20.0;
/// Points below an enter threshold where the matching exit threshold sits.
const EXIT_MARGIN: f64 = 5.0;
/// Points above the strained threshold where `Sick` begins (70 -> 85).
const SICK_GAP: f64 = 15.0;

/// Mochi's health mood. Ordered `Ok < Strained < Sick`, so `max` picks the
/// worse of two readings.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Ok,
    Strained,
    Sick,
}

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
/// Which metric is responsible for the current level, shown in the tooltip.
pub enum Cause {
    Cpu,
    Memory,
    Disk,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
/// Payload of the `health` event sent to the island.
pub struct HealthEvent {
    pub level: Level,
    pub cause: Cause,
    /// Smoothed CPU use, percent.
    pub cpu: f64,
    /// Smoothed memory use, percent.
    pub memory: f64,
    /// Last system-drive used share, percent (0 until first read).
    pub disk: f64,
}

// ── The pure core ────────────────────────────────────────────────────────────

/// One metric's smoothed value.
#[derive(Default, Clone, Copy)]
struct Ema(Option<f64>);

impl Ema {
    /// Folds in a sample and returns the new average; the first sample seeds
    /// the average exactly, so there is no ramp from zero.
    fn push(&mut self, value: f64) -> f64 {
        let next = match self.0 {
            Some(prev) => prev + EMA_ALPHA * (value - prev),
            None => value,
        };
        self.0 = Some(next);
        next
    }
}

/// One metric's level, with the enter/exit hold times plan-v2.md § 7.1 asks
/// for. `timer` is seconds the *relevant* condition for the current level has
/// held continuously — which condition that is depends on the level, so it is
/// reset to 0 the moment that condition stops holding rather than shared
/// across them.
#[derive(Clone, Copy)]
struct Hysteresis {
    level: Level,
    timer: f64,
}

impl Hysteresis {
    /// Starts at `Ok` with no pending hold.
    fn new() -> Self {
        Self { level: Level::Ok, timer: 0.0 }
    }

    /// Advances the track by `dt` seconds with the latest `value` and returns
    /// the (possibly new) level. Moves one step at a time: `Sick` always drops
    /// to `Strained` first.
    ///
    /// `enter` is the threshold that takes this metric from `Ok` to
    /// `Strained`; sick's own enter/exit thresholds and strained's exit
    /// threshold are all derived from it, per this file's own top note.
    fn step(&mut self, value: f64, enter: f64, dt: f64) -> Level {
        let sick_enter = enter + SICK_GAP;
        let strained_exit = enter - EXIT_MARGIN;
        let sick_exit = sick_enter - EXIT_MARGIN;

        let held = match self.level {
            Level::Ok => value >= enter,
            Level::Strained => value >= sick_enter || value < strained_exit,
            Level::Sick => value < sick_exit,
        };
        self.timer = if held { self.timer + dt } else { 0.0 };

        let needed = match self.level {
            Level::Sick => EXIT_HOLD_SECS,
            Level::Strained if value < strained_exit => EXIT_HOLD_SECS,
            _ => ENTER_HOLD_SECS,
        };

        if held && self.timer >= needed {
            self.timer = 0.0;
            self.level = match self.level {
                Level::Ok => Level::Strained,
                Level::Strained if value >= sick_enter => Level::Sick,
                Level::Strained => Level::Ok,
                Level::Sick => Level::Strained,
            };
        }
        self.level
    }
}

/// Everything this file needs from settings — a narrow view rather than the
/// whole `Settings` struct, so the pure core here does not depend on it.
#[derive(Clone, Copy)]
pub struct Config {
    /// Master switch (`health_enabled`); off means the loop only idles.
    pub enabled: bool,
    /// Load (CPU/memory) enter threshold, percent; sick is this plus `SICK_GAP`.
    pub threshold: f64,
    /// Whether the disk track counts toward the level.
    pub include_disk: bool,
    /// Disk enter threshold, percent, independent of the load scale.
    pub disk_threshold: f64,
}

/// The stateful core: EMAs plus the two independent hysteresis tracks (load,
/// disk), composed by taking whichever reads worse. No I/O — `sample` is
/// handed already-read percentages, which is what makes it testable with an
/// injected sequence instead of whatever this machine's CPU happens to be
/// doing when `cargo test` runs.
pub struct Monitor {
    cpu_ema: Ema,
    mem_ema: Ema,
    /// Track for the worse of CPU and memory.
    load: Hysteresis,
    /// Track for the system drive; reset while disk is excluded.
    disk: Hysteresis,
    /// Reused on ticks that do not re-read the drive.
    last_disk_pct: f64,
    /// Seconds since the last heartbeat was emitted — accumulated in real
    /// time (via each call's own `dt`) rather than counted in ticks, so it
    /// stays correct whichever cadence actually calls `sample`.
    heartbeat_timer: f64,
}

impl Monitor {
    /// A monitor at `Ok` with empty averages.
    pub fn new() -> Self {
        Self {
            cpu_ema: Ema::default(),
            mem_ema: Ema::default(),
            load: Hysteresis::new(),
            disk: Hysteresis::new(),
            last_disk_pct: 0.0,
            heartbeat_timer: 0.0,
        }
    }

    /// One tick at `SAMPLE_EVERY`'s cadence (`dt` in seconds — a parameter
    /// rather than the constant itself so a test can drive the clock).
    /// `disk_pct` is `None` on ticks that do not re-read the drive; the last
    /// value read is reused until the next one.
    ///
    /// Returns the event to emit, if any: on a level change, or every
    /// `HEARTBEAT_EVERY_SECS` while not `Ok`.
    pub fn sample(
        &mut self,
        cpu_pct: f64,
        mem_pct: f64,
        disk_pct: Option<f64>,
        dt: f64,
        cfg: &Config,
    ) -> Option<HealthEvent> {
        if let Some(d) = disk_pct {
            self.last_disk_pct = d;
        }

        let cpu = self.cpu_ema.push(cpu_pct);
        let mem = self.mem_ema.push(mem_pct);
        let load_value = cpu.max(mem);

        let before = self.overall();
        let load_level = self.load.step(load_value, cfg.threshold, dt);
        let disk_level = if cfg.include_disk {
            self.disk.step(self.last_disk_pct, cfg.disk_threshold, dt)
        } else {
            // Not tracked: the timer must not accumulate while switched off,
            // or it would fire the instant it is switched back on.
            self.disk = Hysteresis::new();
            Level::Ok
        };
        let after = load_level.max(disk_level);

        let changed = after != before;
        self.heartbeat_timer += dt;
        let heartbeat = after != Level::Ok && self.heartbeat_timer >= HEARTBEAT_EVERY_SECS;
        if changed || heartbeat {
            self.heartbeat_timer = 0.0;
        }
        if !changed && !heartbeat {
            return None;
        }

        let cause = if disk_level > load_level {
            Cause::Disk
        } else if cpu >= mem {
            Cause::Cpu
        } else {
            Cause::Memory
        };

        Some(HealthEvent { level: after, cause, cpu, memory: mem, disk: self.last_disk_pct })
    }

    /// The worse of the load and disk levels.
    fn overall(&self) -> Level {
        self.load.level.max(self.disk.level)
    }
}

// ── The I/O shell ────────────────────────────────────────────────────────────

/// The last event emitted, for `health_state` (a fresh window asks for this
/// on boot rather than waiting up to 10 s for the next heartbeat).
static LAST: Mutex<Option<HealthEvent>> = Mutex::new(None);

/// Debug builds only — forces the next sample to read as this level, so the
/// mood animations can be exercised without loading the machine for real.
/// `None` asks for the real readings again.
#[cfg(debug_assertions)]
static SIMULATE: Mutex<Option<Level>> = Mutex::new(None);

/// Narrows the full settings to the fields this module needs.
fn config_from(settings: &crate::settings::Settings) -> Config {
    Config {
        enabled: settings.health_enabled,
        threshold: settings.health_threshold,
        include_disk: settings.health_include_disk,
        disk_threshold: settings.health_disk_threshold,
    }
}

/// The last emitted event, or `None` if nothing has been reported yet
/// (including while the level has always been `Ok`). Backs the `health_state`
/// command.
pub fn state() -> Option<HealthEvent> {
    LAST.lock().unwrap().clone()
}

/// Debug builds only: force (`Some`) or stop forcing (`None`) a simulated level.
#[cfg(debug_assertions)]
pub fn simulate(level: Option<Level>) {
    *SIMULATE.lock().unwrap() = level;
}

/// Spawns the sampling loop. Paused by the tray's Pause (shared with the
/// integration pollers — pausing Coucou has to mean pausing Coucou) and by
/// `health.enabled` in settings, in which case it sleeps at the sample
/// cadence just checking whether either has changed, and touches no Win32 or
/// `/proc` API while switched off.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut monitor = Monitor::new();
        loop {
            tokio::time::sleep(SAMPLE_EVERY).await;

            let cfg = app
                .try_state::<crate::Shared>()
                .map(|s| config_from(&s.settings.lock().unwrap()))
                .unwrap_or(Config { enabled: false, threshold: 70.0, include_disk: false, disk_threshold: 90.0 });

            if crate::integrations::PAUSED.load(Ordering::Relaxed) || !cfg.enabled {
                continue;
            }

            #[cfg(debug_assertions)]
            if let Some(level) = *SIMULATE.lock().unwrap() {
                let event = simulated_event(level);
                *LAST.lock().unwrap() = Some(event.clone());
                let _ = app.emit_to(WINDOW_LABEL, "health", event);
                continue;
            }

            let (mem_used, mem_total) = platform::memory();
            let mem_pct = if mem_total > 0 { mem_used as f64 / mem_total as f64 * 100.0 } else { 0.0 };
            let cpu_pct = platform::cpu_percent() as f64;

            let want_disk = monitor_needs_disk();
            let disk_pct = if want_disk { Some(disk_percent()) } else { None };

            if let Some(event) = monitor.sample(cpu_pct, mem_pct, disk_pct, SAMPLE_EVERY.as_secs_f64(), &cfg) {
                *LAST.lock().unwrap() = Some(event.clone());
                let _ = app.emit_to(WINDOW_LABEL, "health", event);
            }
        }
    });
}

/// Every `DISK_EVERY_TICKS`th call returns true — a free-standing counter
/// rather than one carried on `Monitor` itself, since reading the drive is
/// this function's job, not the pure core's.
fn monitor_needs_disk() -> bool {
    use std::sync::atomic::{AtomicU32, Ordering as AOrdering};
    static TICKS: AtomicU32 = AtomicU32::new(0);
    let t = TICKS.fetch_add(1, AOrdering::Relaxed);
    t.is_multiple_of(DISK_EVERY_TICKS)
}

/// The system drive's used share, 0 if it cannot be read — the same drive
/// the System tab's own gauge reads (`platform::drives()`'s first entry).
fn disk_percent() -> f64 {
    let Some(drive) = platform::drives().into_iter().next() else { return 0.0 };
    if drive.total == 0 {
        return 0.0;
    }
    (drive.total - drive.free) as f64 / drive.total as f64 * 100.0
}

/// Canned readings for a forced level, so the UI shows plausible numbers.
#[cfg(debug_assertions)]
fn simulated_event(level: Level) -> HealthEvent {
    let (cpu, memory) = match level {
        Level::Ok => (18.0, 45.0),
        Level::Strained => (32.0, 76.0),
        Level::Sick => (91.0, 88.0),
    };
    HealthEvent { level, cause: Cause::Memory, cpu, memory, disk: 20.0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CFG: Config = Config { enabled: true, threshold: 70.0, include_disk: false, disk_threshold: 90.0 };

    #[test]
    fn the_ema_moves_toward_a_held_value_and_starts_exactly_on_the_first_sample() {
        let mut ema = Ema::default();
        assert_eq!(ema.push(50.0), 50.0, "nothing to smooth toward yet");
        let second = ema.push(100.0);
        assert!(second > 50.0 && second < 100.0, "moves toward it, not onto it");
        let mut last = second;
        for _ in 0..40 {
            last = ema.push(100.0);
        }
        assert!((last - 100.0).abs() < 0.01, "settles on a value held long enough");
    }

    #[test]
    fn a_sustained_rise_enters_strained_at_ten_seconds_holds_at_a_dip_and_exits_at_twenty() {
        let mut h = Hysteresis::new();
        // 72 held for 9s: not yet — the hold must be sustained past 10s.
        for _ in 0..9 {
            assert_eq!(h.step(72.0, 70.0, 1.0), Level::Ok);
        }
        assert_eq!(h.step(72.0, 70.0, 1.0), Level::Strained, "72 held 10s crosses the 70 threshold");

        // Dipping to 67 (above the 65 exit line) must not start an exit.
        for _ in 0..30 {
            assert_eq!(h.step(67.0, 70.0, 1.0), Level::Strained);
        }

        // 64 is below the exit line (70 − 5 = 65): 20s of it drops back to ok.
        for _ in 0..19 {
            assert_eq!(h.step(64.0, 70.0, 1.0), Level::Strained);
        }
        assert_eq!(h.step(64.0, 70.0, 1.0), Level::Ok, "64 held 20s crosses back below 65");
    }

    #[test]
    fn strained_escalates_to_sick_fifteen_points_above_the_threshold() {
        let mut h = Hysteresis::new();
        for _ in 0..10 {
            h.step(72.0, 70.0, 1.0);
        }
        assert_eq!(h.level, Level::Strained);
        for _ in 0..9 {
            assert_eq!(h.step(90.0, 70.0, 1.0), Level::Strained);
        }
        assert_eq!(h.step(90.0, 70.0, 1.0), Level::Sick, "90 ≥ 70+15 held 10s");
    }

    #[test]
    fn sick_only_ever_steps_down_to_strained_never_straight_to_ok() {
        let mut h = Hysteresis::new();
        for _ in 0..10 {
            h.step(72.0, 70.0, 1.0);
        }
        for _ in 0..10 {
            h.step(90.0, 70.0, 1.0);
        }
        assert_eq!(h.level, Level::Sick);
        for _ in 0..20 {
            h.step(0.0, 70.0, 1.0);
        }
        assert_eq!(h.level, Level::Strained, "even a reading of 0 lands on strained first");
    }

    fn settled_strained(threshold: f64) -> Monitor {
        let mut m = Monitor::new();
        let cfg = Config { threshold, ..CFG };
        for _ in 0..20 {
            m.sample(threshold + 2.0, 0.0, None, 1.0, &cfg);
        }
        m
    }

    #[test]
    fn a_level_change_is_reported_and_a_steady_level_is_not_reported_every_tick() {
        let mut m = Monitor::new();
        let mut changes = 0;
        for _ in 0..9 {
            if m.sample(72.0, 0.0, None, 1.0, &CFG).is_some() {
                changes += 1;
            }
        }
        assert_eq!(changes, 0, "still ok for the first 9 seconds");
        assert!(m.sample(72.0, 0.0, None, 1.0, &CFG).is_some(), "the 10th second crosses into strained");
    }

    #[test]
    fn disk_cannot_make_it_sick_or_even_strained_when_not_included() {
        let mut m = Monitor::new();
        for _ in 0..40 {
            let event = m.sample(10.0, 10.0, Some(99.0), 1.0, &CFG);
            assert!(event.is_none(), "a full disk with includeDisk off must never be reported");
        }
    }

    #[test]
    fn disk_included_uses_its_own_threshold_not_loads() {
        let cfg = Config { include_disk: true, disk_threshold: 90.0, ..CFG };
        let mut m = Monitor::new();
        // Load stays low throughout; only the disk is past its own threshold.
        for _ in 0..9 {
            assert!(m.sample(10.0, 10.0, Some(95.0), 1.0, &cfg).is_none());
        }
        let event = m.sample(10.0, 10.0, Some(95.0), 1.0, &cfg).expect("disk alone crosses after 10s");
        assert_eq!(event.level, Level::Strained);
        assert_eq!(event.cause, Cause::Disk);
    }

    #[test]
    fn the_heartbeat_repeats_every_ten_seconds_while_not_ok() {
        let mut m = settled_strained(70.0);
        let mut hits = 0;
        for _ in 0..30 {
            if m.sample(72.0, 0.0, None, 1.0, &CFG).is_some() {
                hits += 1;
            }
        }
        assert_eq!(hits, 3, "one heartbeat every 10s over 30s, none of them level changes");
    }
}
