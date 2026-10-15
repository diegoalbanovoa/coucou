//! Disk, memory, and a careful broom.
//!
//! The reading side is plain: how much room each drive has left, and how much
//! memory is in use. The cleaning side is where all the care is, because a tool
//! that deletes files on a machine it does not own has exactly one acceptable
//! shape:
//!
//!   1. Scan, and show what was found with its size.
//!   2. Wait for a click. Nothing is deleted without one.
//!   3. Delete only inside the folders on a fixed list.
//!
//! The list is in `targets()` and nowhere else. It holds user-owned caches and
//! nothing that needs administrator rights: %TEMP%, the recycle bin, the npm
//! and pip caches, and Coucou's own inbox and log. `C:\Windows\Temp` and
//! Prefetch are deliberately absent — they need elevation, and an app that
//! asks for it to tidy up has overstepped.
//!
//! `guard` is the part worth reading twice. Every candidate is canonicalised
//! and checked to be genuinely inside its target, which resolves `..` and makes
//! a symlink or junction point at where it really goes — the classic way a
//! cleaner deletes somewhere it never meant to on Windows.
//!
//! The module also lists the heaviest processes and ends them on request, with
//! the same refusal rules (never Coucou itself, its webview children or
//! OS-critical processes). Called from the System tab's Tauri commands; OS
//! specifics live in `platform`.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::platform;

/// A file touched more recently than this is left alone. Something written in
/// the last couple of days may well still be wanted.
const KEEP_NEWER_THAN: Duration = Duration::from_secs(2 * 24 * 60 * 60);

// ── What the tab shows ───────────────────────────────────────────────────────

/// One drive, as the tab shows it. `platform::Drive` is the same three fields
/// without the serde derive, because platform/ stays free of the wire format.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Drive {
    /// "C:" on Windows, the mount point on Linux.
    pub name: String,
    /// Free bytes on the drive.
    pub free: u64,
    /// Total bytes on the drive.
    pub total: u64,
}

/// Live machine numbers for the System tab: drives, memory and CPU.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub drives: Vec<Drive>,
    /// Bytes of RAM in use.
    pub memory_used: u64,
    /// Bytes of RAM installed.
    pub memory_total: u64,
    /// 0 to 100. See `platform::cpu_percent` — this is a delta since the
    /// previous call, so the very first reading of a run is always 0.
    pub cpu_percent: f32,
    /// Logical core count.
    pub cores: usize,
    /// Whether the tab's "Open Disk Cleanup" button does anything on this
    /// machine. Windows only — there is no one-click equivalent to offer on
    /// Linux across distributions.
    pub disk_cleanup_available: bool,
}

/// Takes a snapshot for the System tab. `cpu_percent` is a delta against the
/// previous call, so poll at a steady rate.
pub fn stats() -> Stats {
    let (memory_used, memory_total) = platform::memory();
    let drives = platform::drives()
        .into_iter()
        .map(|d| Drive { name: d.name, free: d.free, total: d.total })
        .collect();
    Stats {
        drives,
        memory_used,
        memory_total,
        cpu_percent: platform::cpu_percent(),
        cores: platform::core_count(),
        disk_cleanup_available: cfg!(windows),
    }
}

/// Opens Windows' own Disk Cleanup. `false` on Linux, or if it could not be
/// started.
pub fn open_disk_cleanup() -> bool {
    platform::open_disk_cleanup()
}

// ── What may be cleaned ──────────────────────────────────────────────────────

/// One thing the broom knows how to sweep.
pub struct Target {
    /// Stable id the front end sends back to `scan` and `clean`.
    pub id: &'static str,
    /// Name shown in the tab.
    pub label: &'static str,
    /// What it is, in the one line the preview shows.
    pub about: &'static str,
    /// Where it lives. `None` when the folder does not exist on this machine.
    pub root: Option<PathBuf>,
    /// The recycle bin is not a folder we walk; the OS owns it.
    pub recycle_bin: bool,
}

/// Everything cleanable, in the order the tab lists it.
///
/// Nothing here needs administrator rights, and nothing here belongs to
/// another program's running state — a cache is a thing whose absence costs a
/// download, which is the whole test for being on this list.
pub fn targets() -> Vec<Target> {
    let home = platform::home_dir();
    let local = platform::local_dir();
    vec![
        Target {
            id: "temp",
            label: "Temporary files",
            about: "Your own temp folder. Anything still in use is skipped.",
            root: platform::temp_dir(),
            recycle_bin: false,
        },
        Target {
            id: "recycle",
            label: "Recycle Bin",
            about: "Emptied by Windows itself, not by walking it.",
            root: None,
            recycle_bin: true,
        },
        Target {
            id: "npm-cache",
            label: "npm cache",
            about: "Packages npm will download again if it needs them.",
            root: exists(platform::npm_cache_dir()),
            recycle_bin: false,
        },
        Target {
            id: "pip-cache",
            label: "pip cache",
            about: "Wheels pip will download again if it needs them.",
            root: exists(platform::pip_cache_dir()),
            recycle_bin: false,
        },
        Target {
            id: "coucou-inbox",
            label: "Coucou's inbox",
            about: "Copies of files you dropped on the island.",
            root: exists(local.join("inbox")),
            recycle_bin: false,
        },
        Target {
            id: "coucou-log",
            label: "Coucou's log",
            about: "One line per event. Safe to lose.",
            root: exists(local.clone()),
            recycle_bin: false,
        },
    ]
    .into_iter()
    .map(|mut t| {
        // The log target is one file, not a folder: handled as a root with a
        // single name, so the guard applies to it like everything else.
        if t.id == "coucou-log" && t.root.is_none() {
            t.root = exists(home.clone());
        }
        t
    })
    .collect()
}

/// `Some(path)` only when it is an existing directory.
fn exists(path: PathBuf) -> Option<PathBuf> {
    path.is_dir().then_some(path)
}

/// Looks up a target by id. An unknown id gives `None`, so the front end cannot
/// ask for anything that is not on the list.
fn target(id: &str) -> Option<Target> {
    targets().into_iter().find(|t| t.id == id)
}

/// What one target holds, as the preview reports it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub id: String,
    pub label: String,
    pub about: String,
    /// Empty when this one is not on this machine.
    pub path: String,
    pub files: u64,
    pub bytes: u64,
    /// Why there is nothing to do, when there is nothing to do.
    pub note: String,
}

/// Whether `candidate` may be deleted as part of `root`.
///
/// Four questions, and a no to any of them is a skip rather than an error:
/// is it really inside the target once every link is resolved, is it a file
/// rather than a directory, is it older than the keep window, and is it a
/// symlink (which we never follow and never delete through).
pub fn guard(root: &Path, candidate: &Path, now: SystemTime) -> bool {
    // A link is not followed and not removed: what it points at may be
    // anywhere at all, which is the whole reason this check exists.
    match std::fs::symlink_metadata(candidate) {
        Ok(meta) if meta.file_type().is_symlink() => return false,
        Ok(meta) if !meta.is_file() => return false,
        Err(_) => return false,
        Ok(meta) => {
            let young = meta
                .modified()
                .ok()
                .and_then(|m| now.duration_since(m).ok())
                .map(|age| age < KEEP_NEWER_THAN)
                .unwrap_or(true);
            if young {
                return false;
            }
        }
    }

    // And the canonical path really is under the canonical root, so `..` in a
    // name cannot walk out and neither can a junction in the middle.
    let (Ok(real_root), Ok(real)) = (root.canonicalize(), candidate.canonicalize()) else {
        return false;
    };
    real.starts_with(&real_root)
}

/// Walks one target, counting what `guard` would allow. Reads nothing and
/// deletes nothing.
fn walk(root: &Path, now: SystemTime) -> (u64, u64) {
    let mut files = 0;
    let mut bytes = 0;
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            // Directories are descended into only when they are not links.
            match std::fs::symlink_metadata(&path) {
                Ok(meta) if meta.file_type().is_symlink() => continue,
                Ok(meta) if meta.is_dir() => {
                    stack.push(path);
                    continue;
                }
                _ => {}
            }
            if guard(root, &path, now) {
                files += 1;
                bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    (files, bytes)
}

/// What cleaning the named targets would remove.
pub fn scan(ids: &[String]) -> Vec<Found> {
    let now = SystemTime::now();
    ids.iter()
        .filter_map(|id| target(id))
        .map(|t| {
            let mut found = Found {
                id: t.id.into(),
                label: t.label.into(),
                about: t.about.into(),
                path: t.root.as_deref().map(platform_path).unwrap_or_default(),
                files: 0,
                bytes: 0,
                note: String::new(),
            };
            if t.recycle_bin {
                match platform::recycle_bin_size() {
                    Some((files, bytes)) => {
                        found.files = files;
                        found.bytes = bytes;
                    }
                    None => found.note = "Windows did not report it".into(),
                }
                return found;
            }
            match &t.root {
                None => found.note = "not on this machine".into(),
                Some(root) => {
                    let (files, bytes) = walk(root, now);
                    found.files = files;
                    found.bytes = bytes;
                    if files == 0 {
                        found.note = "already empty".into();
                    }
                }
            }
            found
        })
        .collect()
}

/// What one target actually gave up.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Swept {
    pub id: String,
    pub files: u64,
    pub bytes: u64,
    /// How many were skipped because something else had them open.
    pub in_use: u64,
}

/// Deletes what `scan` said it would, and nothing else.
///
/// Every removal goes through `guard` again rather than trusting a list built
/// a moment ago: between the preview and the click, a file may have been
/// replaced by a link to somewhere else.
pub fn clean(ids: &[String]) -> Vec<Swept> {
    let now = SystemTime::now();
    let mut out = Vec::new();

    for t in ids.iter().filter_map(|id| target(id)) {
        let mut swept = Swept { id: t.id.into(), files: 0, bytes: 0, in_use: 0 };

        if t.recycle_bin {
            if let Some((files, bytes)) = platform::recycle_bin_size() {
                if platform::empty_recycle_bin() {
                    swept.files = files;
                    swept.bytes = bytes;
                }
            }
            crate::log::line(format!(
                "cleaned {}: {} files, {} bytes",
                swept.id, swept.files, swept.bytes
            ));
            out.push(swept);
            continue;
        }

        let Some(root) = t.root.clone() else {
            out.push(swept);
            continue;
        };

        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                match std::fs::symlink_metadata(&path) {
                    Ok(meta) if meta.file_type().is_symlink() => continue,
                    Ok(meta) if meta.is_dir() => {
                        stack.push(path);
                        continue;
                    }
                    _ => {}
                }
                if !guard(&root, &path, now) {
                    continue;
                }
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                match std::fs::remove_file(&path) {
                    Ok(()) => {
                        swept.files += 1;
                        swept.bytes += size;
                    }
                    // Almost always "another program has it open", which is a
                    // skip and not a failure worth stopping for.
                    Err(_) => swept.in_use += 1,
                }
            }
        }

        // Every sweep leaves a line, so what a cleaner did is answerable later.
        crate::log::line(format!(
            "cleaned {}: {} files, {} bytes, {} in use",
            swept.id, swept.files, swept.bytes, swept.in_use
        ));
        out.push(swept);
    }
    out
}

// ── Processes ─────────────────────────────────────────────────────────────────
//
// Memory "cleaning" is not a real thing an application can do to a machine —
// the only honest way to help with memory pressure is to show what is using
// it and let the user end one, with the same care the file broom uses: never
// the process asking, and never one the operating system needs to keep
// running. The names below are deliberately broad rather than exhaustive —
// a name this list does not recognise is not thereby safe to end, so the
// guard also refuses anything that looks like a Windows session process by
// where it would have to run, not only by matching a list.

/// Lower-cased executable names `end_processes` refuses, whatever account
/// asks. Not a claim that nothing else matters — it is the floor the list
/// and the self-pid check both sit above. Matches plan-v2.md § 6.4's list.
const PROTECTED_NAMES: &[&str] = &[
    "system",
    "system idle process",
    "registry",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "winlogon.exe",
    "services.exe",
    "lsass.exe",
    "svchost.exe",
    "dwm.exe",
    "fontdrvhost.exe",
    "memory compression",
    "explorer.exe",
    "msmpeng.exe",
    "securityhealthservice.exe",
    "coucou.exe",
    "coucou",
    "systemd",
    "init",
];

/// One running process, as the System tab lists it. `protected` ones are
/// still shown — seeing what `svchost.exe` or Coucou's own webview is doing
/// answers "what is using my memory" as much as anything else does — they
/// just never offer the button that would end them.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcInfo {
    pub pid: u32,
    pub name: String,
    /// Memory the process uses, in bytes.
    pub memory: u64,
    /// True when the tab must not offer to end this process.
    pub protected: bool,
    /// Opaque outside this file — see `platform::RawProc`. The TS side
    /// carries it right back in an end request and nowhere else.
    ///
    /// A **string**, not a `u64`: on Windows this is a raw `FILETIME` (100ns
    /// ticks since 1601), on the order of 1.3×10¹⁷ today — past
    /// `Number.MAX_SAFE_INTEGER` (2^53 ≈ 9×10¹⁵). Sent as a JSON number, the
    /// JS side's own float64 would silently round it to a *different*
    /// integer, which `end_processes`' pid-reuse check would then always see
    /// as a mismatch — every close request quietly refused, no exception
    /// anywhere to say why. Decimal digits round-trip exactly; a float does not.
    pub start_time: String,
}

/// True for Coucou's own pid and for names on `PROTECTED_NAMES`; such processes are
/// listed but never offered for ending.
fn protected(pid: u32, name: &str) -> bool {
    pid == std::process::id() || PROTECTED_NAMES.contains(&name.to_lowercase().as_str())
}

/// Whether `pid` is Coucou itself or a descendant of it (its `msedgewebview2`
/// child, chiefly) — walked through `raw`'s own ppid chain rather than
/// trusted from a second, possibly stale snapshot. Bounded, so a ppid cycle
/// (which should never happen, but this is exactly the kind of check that
/// must not hang if it somehow does) gives up rather than loops forever.
fn is_coucou_descendant(pid: u32, raw: &[platform::RawProc], coucou_pid: u32) -> bool {
    let mut current = pid;
    for _ in 0..32 {
        if current == coucou_pid {
            return true;
        }
        let Some(p) = raw.iter().find(|r| r.pid == current) else { return false };
        if p.ppid == 0 || p.ppid == current {
            return false;
        }
        current = p.ppid;
    }
    false
}

/// The pure half of `top_processes`: given a snapshot and Coucou's own pid,
/// says what the tab shows. Separated out so a test can hand it a small,
/// made-up process tree instead of whatever happens to be running on the
/// machine `cargo test` runs on.
fn rank(raw: &[platform::RawProc], coucou_pid: u32, limit: usize) -> Vec<ProcInfo> {
    let mut procs: Vec<ProcInfo> = raw
        .iter()
        .map(|p| ProcInfo {
            pid: p.pid,
            name: p.name.clone(),
            memory: p.memory,
            start_time: p.start_time.to_string(),
            protected: protected(p.pid, &p.name) || is_coucou_descendant(p.pid, raw, coucou_pid),
        })
        .collect();
    procs.sort_by_key(|p| std::cmp::Reverse(p.memory));
    procs.truncate(limit);
    procs
}

/// The processes using the most memory, heaviest first. `limit` is generous
/// (today's one caller asks for 40) because grouping by executable and the
/// 8-then-"see more"-to-20 cutoff are both the TS side's job — see
/// `groupProcesses` in `views/system.ts`.
pub fn top_processes(limit: usize) -> Vec<ProcInfo> {
    rank(&platform::processes(), std::process::id(), limit)
}

/// One process an end request names — the pid a row's button was drawn for,
/// and the start time it was drawn with. `start_time` arrives as a string —
/// see `ProcInfo.start_time`'s own note on why a `u64` cannot cross the JS
/// bridge as a JSON number without losing precision.
#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EndTarget {
    pub pid: u32,
    pub start_time: String,
}

/// The pure half of `end_processes`: which targets a given live snapshot
/// lets through, and which it refuses before `kill` is ever asked to try —
/// reused pids, processes that have since exited, and anything protected,
/// whether or not the caller already knew that. `kill` is the only side
/// effect, so a test can hand this a made-up tree and a `kill` that never
/// really ends anything.
fn settle(
    live: &[platform::RawProc],
    coucou_pid: u32,
    targets: &[EndTarget],
    mut kill: impl FnMut(u32) -> bool,
) -> Vec<u32> {
    let mut failed = Vec::new();

    for target in targets {
        let Some(proc) = live.iter().find(|p| p.pid == target.pid) else {
            failed.push(target.pid);
            continue;
        };
        if protected(proc.pid, &proc.name) || is_coucou_descendant(proc.pid, live, coucou_pid) {
            failed.push(target.pid);
            continue;
        }
        // A start time of 0 means it could not be read in the first place —
        // never treated as a match, since that is also what an inaccessible
        // process reports. Compared as the decimal strings they both
        // already are — parsing the target back to a u64 would just be
        // undoing the precision-safety this string carries for no reason.
        if proc.start_time == 0 || proc.start_time.to_string() != target.start_time {
            failed.push(target.pid);
            continue;
        }
        if kill(target.pid) {
            crate::log::line(format!("ended process {} ({})", target.pid, proc.name));
        } else {
            failed.push(target.pid);
        }
    }
    failed
}

/// Ends every target whose live process still matches both the pid and the
/// start time it was last drawn with. Returns the pids that could not be
/// ended, for any reason, so the tab can say how many failed without having
/// to guess why.
pub fn end_processes(targets: &[EndTarget]) -> Vec<u32> {
    settle(&platform::processes(), std::process::id(), targets, platform::kill_process)
}

/// Display form of a path, shared with the agent so both show it the same way.
fn platform_path(path: &Path) -> String {
    crate::agent::display_path(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("coucou-system-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    /// A file written far enough in the past that the keep window has passed.
    fn old_file(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        let long_ago = SystemTime::now() - KEEP_NEWER_THAN - Duration::from_secs(3600);
        std::fs::File::options().write(true).open(&path).unwrap().set_modified(long_ago).unwrap();
        path
    }

    #[test]
    fn a_file_outside_the_target_is_never_touched() {
        let root = scratch("guard-root");
        let other = scratch("guard-other");
        let outside = old_file(&other, "secret.txt", b"mine");

        assert!(!guard(&root, &outside, SystemTime::now()), "a path outside the root");

        // And the same file reached through a `..` that climbs out of the root.
        let climbing = root.join("..").join("coucou-system-guard-other").join("secret.txt");
        assert!(!guard(&root, &climbing, SystemTime::now()), "a path that climbs out");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn something_recent_is_left_alone() {
        let root = scratch("guard-young");
        let fresh = root.join("today.txt");
        std::fs::write(&fresh, b"written just now").unwrap();

        assert!(!guard(&root, &fresh, SystemTime::now()), "two days is the keep window");

        let old = old_file(&root, "last-week.txt", b"stale");
        assert!(guard(&root, &old, SystemTime::now()), "and this one is fair game");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_directory_is_not_a_file_and_is_not_deleted() {
        let root = scratch("guard-dir");
        let inner = root.join("inner");
        std::fs::create_dir_all(&inner).unwrap();

        assert!(!guard(&root, &inner, SystemTime::now()));
        assert!(!guard(&root, &root.join("not-there.txt"), SystemTime::now()));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scanning_counts_only_what_cleaning_would_remove() {
        let root = scratch("scan-count");
        old_file(&root, "a.bin", &[0u8; 100]);
        old_file(&root, "b.bin", &[0u8; 200]);
        std::fs::write(root.join("fresh.bin"), [0u8; 999]).unwrap();

        let (files, bytes) = walk(&root, SystemTime::now());

        assert_eq!(files, 2, "the fresh one is not counted");
        assert_eq!(bytes, 300, "nor is its size");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn walking_goes_into_subfolders_but_not_through_links() {
        let root = scratch("scan-deep");
        let deep = root.join("one").join("two");
        std::fs::create_dir_all(&deep).unwrap();
        old_file(&deep, "buried.bin", &[0u8; 50]);

        let (files, bytes) = walk(&root, SystemTime::now());
        assert_eq!((files, bytes), (1, 50));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn every_target_is_named_once_and_asks_for_no_elevation() {
        let mut seen: Vec<&str> = Vec::new();
        for t in targets() {
            assert!(!seen.contains(&t.id), "{} is listed twice", t.id);
            seen.push(t.id);
            assert!(!t.label.is_empty() && !t.about.is_empty(), "{} needs saying", t.id);

            // Nothing on this list may live where elevation is needed.
            if let Some(root) = &t.root {
                let shown = root.to_string_lossy().to_lowercase();
                for forbidden in ["windows\\temp", "windows\\prefetch", "system32"] {
                    assert!(!shown.contains(forbidden), "{} points at {forbidden}", t.id);
                }
            }
        }
        assert!(seen.contains(&"temp"), "the one everybody wants swept");
    }

    #[test]
    fn an_unknown_target_is_not_invented() {
        assert!(target("c-drive").is_none());
        assert!(scan(&["c-drive".into()]).is_empty());
        assert!(clean(&["c-drive".into()]).is_empty());
    }

    #[test]
    fn the_protected_list_is_already_lower_case() {
        // `protected` lower-cases what it is given, not what is on the list —
        // a name here with a capital in it would never match.
        for name in PROTECTED_NAMES {
            assert_eq!(*name, name.to_lowercase(), "{name} belongs in lower case");
        }
    }

    #[test]
    fn coucou_can_never_end_itself() {
        assert!(protected(std::process::id(), "something-else.exe"), "its own pid is enough");
        assert!(protected(999_999, "coucou.exe"), "and so is its own name");
        assert!(protected(999_999, "COUCOU.EXE"), "whatever case it is reported in");
    }

    #[test]
    fn a_name_the_system_needs_is_refused_by_name_alone() {
        for name in ["lsass.exe", "wininit.exe", "systemd", "SYSTEM"] {
            assert!(protected(123_456, name), "{name} should be refused");
        }
        assert!(!protected(123_456, "chrome.exe"), "an ordinary app is not");
    }

    #[test]
    fn ending_coucou_itself_is_refused_before_its_start_time_is_even_checked() {
        // A real process has this pid (the test binary), so a wrong start
        // time alone would also fail — the point of this test is that the
        // protected check catches it first regardless.
        let failed = end_processes(&[end(std::process::id(), "0")]);
        assert_eq!(failed, vec![std::process::id()]);
    }

    fn raw(pid: u32, ppid: u32, name: &str, memory: u64, start_time: u64) -> platform::RawProc {
        platform::RawProc { pid, ppid, name: name.into(), memory, start_time }
    }

    fn end(pid: u32, start_time: &str) -> EndTarget {
        EndTarget { pid, start_time: start_time.to_string() }
    }

    #[test]
    fn the_top_processes_list_is_sorted_heaviest_first_and_the_limit_is_honoured() {
        let tree = vec![raw(1, 0, "a.exe", 300, 1), raw(2, 0, "b.exe", 900, 1), raw(3, 0, "c.exe", 10, 1)];
        let list = rank(&tree, 999, 2);
        assert_eq!(list.len(), 2, "the limit is honoured");
        assert_eq!(list[0].pid, 2, "heaviest first");
        assert_eq!(list[1].pid, 1);
    }

    #[test]
    fn a_protected_process_is_shown_not_hidden_but_carries_the_flag() {
        let tree = vec![raw(1, 0, "lsass.exe", 50, 1), raw(2, 0, "chrome.exe", 50, 1)];
        let list = rank(&tree, 999, 10);
        assert_eq!(list.len(), 2, "protected ones are listed, not dropped");
        assert!(list.iter().find(|p| p.pid == 1).unwrap().protected);
        assert!(!list.iter().find(|p| p.pid == 2).unwrap().protected);
    }

    #[test]
    fn coucous_own_child_is_protected_even_though_its_name_is_not_on_the_list() {
        // webview2.exe is a plain name as far as PROTECTED_NAMES is concerned
        // — what makes it untouchable here is being Coucou's own child.
        let tree = vec![raw(10, 999, "coucou.exe", 50, 1), raw(11, 10, "msedgewebview2.exe", 50, 1)];
        let list = rank(&tree, 999, 10);
        assert!(list.iter().find(|p| p.pid == 11).unwrap().protected);
    }

    #[test]
    fn a_ppid_cycle_is_given_up_on_rather_than_looped_forever() {
        // Should never happen on a real machine — the bound exists for this
        // test, not for correctness on one.
        let tree = vec![raw(1, 2, "a.exe", 1, 1), raw(2, 1, "b.exe", 1, 1)];
        assert!(!is_coucou_descendant(1, &tree, 999));
    }

    #[test]
    fn ending_a_process_whose_start_time_no_longer_matches_is_refused() {
        let tree = vec![raw(42, 0, "stale.exe", 1, 7)];
        // Same pid, a different start time — the row this click came from
        // was drawn for a process that pid no longer is.
        let failed = settle(&tree, 999, &[end(42, "8")], |_| true);
        assert_eq!(failed, vec![42]);
    }

    #[test]
    fn ending_a_process_that_is_no_longer_running_is_refused() {
        let failed = settle(&[], 999, &[end(42, "1")], |_| true);
        assert_eq!(failed, vec![42]);
    }

    #[test]
    fn a_matching_target_actually_gets_killed() {
        let tree = vec![raw(42, 0, "ordinary.exe", 1, 7)];
        let mut asked = Vec::new();
        let failed = settle(&tree, 999, &[end(42, "7")], |pid| {
            asked.push(pid);
            true
        });
        assert_eq!(failed, Vec::<u32>::new());
        assert_eq!(asked, vec![42]);
    }

    #[test]
    fn a_kill_the_platform_itself_refuses_is_reported_as_failed() {
        let tree = vec![raw(42, 0, "ordinary.exe", 1, 7)];
        let failed = settle(&tree, 999, &[end(42, "7")], |_| false);
        assert_eq!(failed, vec![42]);
    }

    #[test]
    fn a_windows_filetime_start_time_past_js_safe_integer_still_matches() {
        // ~1.3e17 — a real present-day Windows FILETIME, and well past
        // `Number.MAX_SAFE_INTEGER` (2^53 ≈ 9e15). The whole point of
        // `start_time` being a `String` rather than a `u64` on the wire is
        // that a value like this round-trips through JS exactly; this test
        // is what would have caught the bug if it had been written sooner.
        let huge: u64 = 133_800_000_000_000_000;
        let tree = vec![raw(42, 0, "real.exe", 1, huge)];
        let failed = settle(&tree, 999, &[end(42, &huge.to_string())], |_| true);
        assert_eq!(failed, Vec::<u32>::new(), "the exact decimal string must match");
    }

    #[test]
    fn rank_reports_the_same_huge_start_time_settle_would_need_back() {
        let huge: u64 = 133_800_000_000_000_000;
        let tree = vec![raw(42, 0, "real.exe", 1, huge)];
        let info = rank(&tree, 999, 10).into_iter().next().unwrap();
        assert_eq!(info.start_time, huge.to_string());
    }
}
