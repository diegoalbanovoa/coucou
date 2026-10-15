//! Everything that differs between operating systems, behind one set of names.
//!
//! The rest of the app calls `platform::...` and never touches Win32 or a Linux
//! API directly. Each OS file exposes the same functions; the compiler picks one
//! with `#[cfg]` and re-exports it here. The cross-platform types ([`Drive`],
//! [`RawProc`], [`LocalTime`]) live in this file so callers and both backends
//! agree on their shape; they carry no serde derives (the wire format belongs to
//! the callers, e.g. `system.rs`).

use std::path::PathBuf;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::*;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use self::linux::*;

/// One drive and the room left on it. Filled in per platform; see `drives`.
pub struct Drive {
    pub name: String,
    pub free: u64,
    pub total: u64,
}

/// One running process exactly as the OS reports it — before `system.rs`
/// decides what any of it means (protected, grouped, offered to end).
///
/// `start_time` has no shared meaning across platforms and is never shown:
/// it only needs to change when a pid is recycled, so `system_end_process`
/// can tell "the process the row was drawn for" from "a different one that
/// happens to have the same pid now".
pub struct RawProc {
    pub pid: u32,
    /// Parent process id; 0 when unknown.
    pub ppid: u32,
    pub name: String,
    /// Memory in use by the process, in bytes (resident set).
    pub memory: u64,
    /// Opaque start stamp; 0 means it could not be read.
    pub start_time: u64,
}

/// The number of logical cores, for the System tab's CPU gauge detail line.
pub fn core_count() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
}

/// Wall-clock time in the user's time zone, for log lines and backup names.
pub struct LocalTime {
    pub year: u32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

/// An executable, looked for on PATH first and then in the folders the tools
/// that install agent CLIs use. See each platform's `extra_bin_dirs`.
pub fn find_exe(stem: &str) -> Option<PathBuf> {
    find_on_path(stem).or_else(|| extra_bin_dirs().iter().find_map(|dir| find_in(dir, stem)))
}

/// The user's home directory, where `.claude/settings.json` lives.
pub fn home_dir() -> PathBuf {
    std::env::var_os(HOME_VAR)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}
