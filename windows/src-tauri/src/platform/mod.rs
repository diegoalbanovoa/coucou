// Everything that differs between operating systems, behind one set of names.
//
// The rest of the app calls `platform::…` and never touches Win32 or a Linux
// API directly. Each OS file exposes the same functions; the compiler picks one.

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
