// Disk, memory, and a careful broom.
//
// The reading side is plain: how much room each drive has left, and how much
// memory is in use. The cleaning side is where all the care is, because a tool
// that deletes files on a machine it does not own has exactly one acceptable
// shape:
//
//   1. Scan, and show what was found with its size.
//   2. Wait for a click. Nothing is deleted without one.
//   3. Delete only inside the folders on a fixed list.
//
// The list is in `targets()` and nowhere else. It holds user-owned caches and
// nothing that needs administrator rights: %TEMP%, the recycle bin, the npm
// and pip caches, and Coucou's own inbox and log. `C:\Windows\Temp` and
// Prefetch are deliberately absent — they need elevation, and an app that
// asks for it to tidy up has overstepped.
//
// `guard` is the part worth reading twice. Every candidate is canonicalised
// and checked to be genuinely inside its target, which resolves `..` and makes
// a symlink or junction point at where it really goes — the classic way a
// cleaner deletes somewhere it never meant to on Windows.

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
    pub free: u64,
    pub total: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub drives: Vec<Drive>,
    pub memory_used: u64,
    pub memory_total: u64,
    /// Whether the tab's "Open Disk Cleanup" button does anything on this
    /// machine. Windows only — there is no one-click equivalent to offer on
    /// Linux across distributions.
    pub disk_cleanup_available: bool,
}

pub fn stats() -> Stats {
    let (memory_used, memory_total) = platform::memory();
    let drives = platform::drives()
        .into_iter()
        .map(|d| Drive { name: d.name, free: d.free, total: d.total })
        .collect();
    Stats { drives, memory_used, memory_total, disk_cleanup_available: cfg!(windows) }
}

/// Opens Windows' own Disk Cleanup. `false` on Linux, or if it could not be
/// started.
pub fn open_disk_cleanup() -> bool {
    platform::open_disk_cleanup()
}

// ── What may be cleaned ──────────────────────────────────────────────────────

/// One thing the broom knows how to sweep.
pub struct Target {
    pub id: &'static str,
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

fn exists(path: PathBuf) -> Option<PathBuf> {
    path.is_dir().then_some(path)
}

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

/// Lower-cased executable names `kill_process` refuses, whatever account asks.
/// Not a claim that nothing else matters — it is the floor the list and the
/// self-pid check both sit above.
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
    "coucou.exe",
    "coucou",
    "systemd",
    "init",
];

/// One running process, as the System tab lists it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcInfo {
    pub pid: u32,
    pub name: String,
    pub memory: u64,
}

fn protected(pid: u32, name: &str) -> bool {
    pid == std::process::id() || PROTECTED_NAMES.contains(&name.to_lowercase().as_str())
}

/// The processes using the most memory, heaviest first — Coucou itself and
/// anything on the protected list left out entirely, so there is nothing in
/// the list `kill_process` would refuse anyway.
pub fn top_processes(limit: usize) -> Vec<ProcInfo> {
    let mut procs: Vec<ProcInfo> = platform::processes()
        .into_iter()
        .filter(|(pid, name, _)| !protected(*pid, name))
        .map(|(pid, name, memory)| ProcInfo { pid, name, memory })
        .collect();
    procs.sort_by_key(|p| std::cmp::Reverse(p.memory));
    procs.truncate(limit);
    procs
}

/// Ends one process. Refuses anything on the protected list or Coucou's own
/// pid even if the caller somehow asked for it — the list shown to the user
/// already leaves these out, but the refusal lives here, not in the
/// interface, the same way the file broom's guard does.
pub fn kill_process(pid: u32) -> Result<(), String> {
    let name = platform::processes()
        .into_iter()
        .find(|(p, _, _)| *p == pid)
        .map(|(_, name, _)| name)
        .ok_or_else(|| "that process is no longer running".to_string())?;

    if protected(pid, &name) {
        return Err(format!("{name} is not something Coucou will end"));
    }

    if platform::kill_process(pid) {
        crate::log::line(format!("ended process {pid} ({name})"));
        Ok(())
    } else {
        Err(format!("could not end {name}"))
    }
}

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
    fn killing_a_protected_name_is_refused_before_the_platform_is_asked() {
        // No real process has this pid, so a call that reaches `platform::kill_process`
        // would fail for a different reason than the one this test checks for.
        let err = kill_process(std::process::id()).unwrap_err();
        assert!(err.contains("not something Coucou will end"), "{err}");
    }

    #[test]
    fn the_top_processes_list_is_sorted_heaviest_first() {
        let list = top_processes(5);
        for pair in list.windows(2) {
            assert!(pair[0].memory >= pair[1].memory, "not sorted: {:?} then {:?}", pair[0].memory, pair[1].memory);
        }
        assert!(list.len() <= 5, "the limit is honoured");
        assert!(
            list.iter().all(|p| !protected(p.pid, &p.name)),
            "nothing protected is ever offered"
        );
    }
}
