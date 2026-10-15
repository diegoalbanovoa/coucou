//! Small append-only log at `%LOCALAPPDATA%\Coucou\coucou.log` (Windows) or
//! `~/.local/share/coucou/coucou.log` (Linux) — the equivalent of `nbLog()` in
//! `HookServer.swift`. Nothing leaves the machine.
//!
//! Called from every other module for diagnostics. Callers must never pass
//! secrets or file contents: the log is plain text (though owner-only on Unix).
//! All I/O errors are swallowed on purpose; logging must never break a caller.

use std::io::Write;

use crate::{platform, settings};

/// Appends one timestamped (local time) line to the log file.
///
/// Creates the private data directory if needed and truncates the file by
/// deleting it once it passes ~1 MB. Best effort: failures are ignored.
pub fn line(message: impl AsRef<str>) {
    let t = platform::local_time();
    let stamp = format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        t.year, t.month, t.day, t.hour, t.minute, t.second
    );
    let dir = settings::local_dir();
    if platform::ensure_private_dir(&dir).is_err() {
        return;
    }
    let path = dir.join("coucou.log");
    // Keep it from growing forever: start fresh past ~1 MB.
    if std::fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    // Readable by us only, like the macOS log.
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    if let Ok(mut file) = options.open(path) {
        let _ = writeln!(file, "{stamp} {}", message.as_ref());
    }
}
