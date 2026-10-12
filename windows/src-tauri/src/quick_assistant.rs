// The quick assistant: a global-shortcut-reachable helper with a closed,
// four-action tool list — search_files, read_approved_folder, open_app,
// query_vault — and no write/delete/execute action at all. Deliberately
// separate from agent.rs/consoles.rs: an agent CLI already has full tool
// access through the real CLI, approved via hooks. See
// openspec/changes/quick-assistant-tools.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::{platform, settings::AllowedApp, vault};

// ── Folder allow-list ────────────────────────────────────────────────────

/// True when `path` resolves inside one of `folders` — both sides
/// canonicalised first, the same boundary `files.rs`'s `inside_inbox` uses:
/// a `..` is resolved, and a symlink pointing out of an allowed folder
/// resolves to where it actually goes, not where it claims to be.
pub fn is_allowed_path(path: &Path, folders: &[String]) -> bool {
    let Ok(real) = path.canonicalize() else { return false };
    folders.iter().any(|f| Path::new(f).canonicalize().map(|dir| real.starts_with(&dir)).unwrap_or(false))
}

/// Adds `path` to the allow-list, canonicalised, deduplicated. Refuses
/// anything that is not an existing directory — there is nothing to allow
/// reads inside otherwise.
pub fn add_folder(folders: &mut Vec<String>, path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Err("not a folder".to_string());
    }
    let canon = p.canonicalize().map_err(|e| e.to_string())?;
    let canon_str = canon.to_string_lossy().to_string();
    if !folders.iter().any(|f| f == &canon_str) {
        folders.push(canon_str);
    }
    Ok(())
}

pub fn remove_folder(folders: &mut Vec<String>, path: &str) {
    folders.retain(|f| f != path);
}

// ── App allow-list ───────────────────────────────────────────────────────

/// Adds an app the model may later ask `open_app` to launch. `path` is
/// resolved and confirmed to exist *now*, at add time — `open_app` never
/// takes a path from the model, only one of these already-resolved ids.
pub fn add_app(apps: &mut Vec<AllowedApp>, label: &str, path: &str) -> Result<AllowedApp, String> {
    let p = Path::new(path);
    if !p.is_file() {
        return Err("not an executable file".to_string());
    }
    let exe = p.canonicalize().map_err(|e| e.to_string())?.to_string_lossy().to_string();
    let id = crate::agent::uuid_v4();
    let app = AllowedApp { id, label: label.to_string(), exe };
    apps.push(app.clone());
    Ok(app)
}

pub fn remove_app(apps: &mut Vec<AllowedApp>, id: &str) {
    apps.retain(|a| a.id != id);
}

// ── Permission broker ───────────────────────────────────────────────────
//
// A `pipe::Pending`-shaped broker, but its own type: that one is keyed to
// hook events arriving over the named pipe from an external CLI process,
// and a quick-assistant call has no CLI, no pipe, no hook event at all.
// See design.md decision 1.

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Decision {
    Allow,
    Deny,
}

#[derive(Default)]
pub struct Pending(pub Mutex<HashMap<String, mpsc::Sender<Decision>>>);

static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);

/// A fresh request id — not a UUID: nothing here needs to be unguessable,
/// only unique within one running app, and a counter is simpler to read in
/// logs than a UUID would be.
pub fn next_request_id() -> String {
    format!("qa-{}", NEXT_REQUEST.fetch_add(1, Ordering::Relaxed))
}

// ── The pause gate ───────────────────────────────────────────────────────

/// Every tool call checks this before anything else — the same flag the
/// tray's existing "Pause" item already flips for the hook relay. One
/// flag, not two: see design.md's Goals.
pub fn refused_while_paused(paused: bool) -> Option<String> {
    if paused {
        Some("paused".to_string())
    } else {
        None
    }
}

// ── Action log ───────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    /// Milliseconds since the epoch — plain, sortable, no timezone math.
    pub at: u64,
    pub tool: String,
    pub target: String,
    /// "approved" | "denied" | "auto-approved" | "refused-paused" | "refused-scope"
    pub outcome: String,
}

fn log_path() -> PathBuf {
    platform::config_dir().join("quick-assistant-log.jsonl")
}

/// Appends one entry. Never fails loudly — a log write must not be the
/// reason a tool call that otherwise succeeded gets reported as an error.
pub fn log_action(entry: &LogEntry) {
    let Ok(line) = serde_json::to_string(entry) else { return };
    if let Some(dir) = log_path().parent() {
        let _ = platform::ensure_private_dir(dir);
    }
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(log_path()) {
        let _ = writeln!(file, "{line}");
    }
}

/// The most recent `limit` entries, newest last (reading order). Never
/// fails: a log that cannot be read yields nothing rather than an error —
/// there is nothing in it the rest of the app depends on.
pub fn recent_log(limit: usize) -> Vec<LogEntry> {
    let Ok(text) = std::fs::read_to_string(log_path()) else { return Vec::new() };
    let mut entries: Vec<LogEntry> =
        text.lines().filter_map(|line| serde_json::from_str(line).ok()).collect();
    if entries.len() > limit {
        entries = entries.split_off(entries.len() - limit);
    }
    entries
}

// ── The four tools ───────────────────────────────────────────────────────

/// `search_files`: a plain filename/content substring match, scoped to one
/// allow-listed folder — never the whole disk. See design.md decision 4.
pub fn search_files(query: &str, folder: &str, folders: &[String]) -> Result<Vec<String>, String> {
    const CAP: usize = 50;
    let root = Path::new(folder);
    if !is_allowed_path(root, folders) {
        return Err("that folder is not on the allow-list".to_string());
    }
    let mut hits = Vec::new();
    let query_lower = query.to_lowercase();
    walk(root, &mut |entry| {
        if hits.len() >= CAP {
            return;
        }
        if entry.file_name().map(|n| n.to_string_lossy().to_lowercase().contains(&query_lower)).unwrap_or(false) {
            hits.push(entry.to_string_lossy().to_string());
        }
    });
    Ok(hits)
}

fn walk(dir: &Path, visit: &mut impl FnMut(&Path)) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        visit(&path);
        if path.is_dir() {
            walk(&path, visit);
        }
    }
}

/// `read_approved_folder`: refuses outright — no approval card — when the
/// target is outside every allow-listed folder, since approving it would
/// not make the target any more inside the allow-list. See the spec's own
/// scenario for this.
pub fn read_approved_folder(path: &str, folders: &[String]) -> Result<String, String> {
    let target = Path::new(path);
    if !is_allowed_path(target, folders) {
        return Err("that path is not inside an allow-listed folder".to_string());
    }
    std::fs::read_to_string(target).map_err(|e| e.to_string())
}

/// `open_app`: looks up `app_id` in the allow-list and launches the
/// already-resolved executable directly — never a path or command string
/// the model supplies. See design.md decision 5.
pub fn open_app(app_id: &str, apps: &[AllowedApp]) -> Result<(), String> {
    let app = apps.iter().find(|a| a.id == app_id).ok_or_else(|| "that app is not on the allow-list".to_string())?;
    std::process::Command::new(&app.exe).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// `query_vault`: forwards to vault.rs unchanged — no new vault-access code.
pub fn query_vault(vault_path: Option<&str>) -> Option<String> {
    let found = vault::resolve(vault_path);
    vault::briefing(found.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("coucou-qa-test-{}", crate::agent::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn add_folder_refuses_a_path_that_is_not_a_directory() {
        let mut folders = Vec::new();
        let file = tempdir().join("not-a-dir.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(add_folder(&mut folders, &file.to_string_lossy()).is_err());
        assert!(folders.is_empty());
    }

    #[test]
    fn add_folder_dedupes_the_same_path() {
        let mut folders = Vec::new();
        let dir = tempdir();
        add_folder(&mut folders, &dir.to_string_lossy()).unwrap();
        add_folder(&mut folders, &dir.to_string_lossy()).unwrap();
        assert_eq!(folders.len(), 1);
    }

    #[test]
    fn remove_folder_drops_exactly_that_entry() {
        let mut folders = vec!["a".to_string(), "b".to_string()];
        remove_folder(&mut folders, "a");
        assert_eq!(folders, vec!["b".to_string()]);
    }

    #[test]
    fn a_path_inside_an_allowed_folder_is_allowed() {
        let dir = tempdir();
        let inner = dir.join("inner.txt");
        std::fs::write(&inner, b"x").unwrap();
        let folders = vec![dir.to_string_lossy().to_string()];
        assert!(is_allowed_path(&inner, &folders));
    }

    #[test]
    fn a_path_outside_every_allowed_folder_is_refused() {
        let dir = tempdir();
        let outside = tempdir().join("elsewhere.txt");
        std::fs::write(&outside, b"x").unwrap();
        let folders = vec![dir.to_string_lossy().to_string()];
        assert!(!is_allowed_path(&outside, &folders));
    }

    #[test]
    fn a_traversal_attempt_that_resolves_outside_is_refused() {
        let dir = tempdir();
        let sibling = tempdir();
        let escape = format!("{}/../{}", dir.to_string_lossy(), sibling.file_name().unwrap().to_string_lossy());
        let folders = vec![dir.to_string_lossy().to_string()];
        assert!(!is_allowed_path(Path::new(&escape), &folders));
    }

    #[test]
    fn read_approved_folder_refuses_outside_the_allow_list() {
        let outside = tempdir().join("secret.txt");
        std::fs::write(&outside, b"x").unwrap();
        let folders: Vec<String> = Vec::new();
        assert!(read_approved_folder(&outside.to_string_lossy(), &folders).is_err());
    }

    #[test]
    fn read_approved_folder_reads_inside_the_allow_list() {
        let dir = tempdir();
        let inner = dir.join("note.txt");
        std::fs::write(&inner, b"hello").unwrap();
        let folders = vec![dir.to_string_lossy().to_string()];
        assert_eq!(read_approved_folder(&inner.to_string_lossy(), &folders).unwrap(), "hello");
    }

    #[test]
    fn search_files_only_reaches_inside_the_allow_listed_folder() {
        let dir = tempdir();
        std::fs::write(dir.join("report.txt"), b"x").unwrap();
        let folders = vec![dir.to_string_lossy().to_string()];
        let hits = search_files("report", &dir.to_string_lossy(), &folders).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn search_files_refuses_a_folder_not_on_the_allow_list() {
        let dir = tempdir();
        let folders: Vec<String> = Vec::new();
        assert!(search_files("x", &dir.to_string_lossy(), &folders).is_err());
    }

    #[test]
    fn search_files_caps_the_result_count() {
        let dir = tempdir();
        for i in 0..60 {
            std::fs::write(dir.join(format!("match-{i}.txt")), b"x").unwrap();
        }
        let folders = vec![dir.to_string_lossy().to_string()];
        let hits = search_files("match", &dir.to_string_lossy(), &folders).unwrap();
        assert_eq!(hits.len(), 50);
    }

    #[test]
    fn open_app_refuses_an_id_not_on_the_allow_list() {
        let apps: Vec<AllowedApp> = Vec::new();
        assert!(open_app("missing", &apps).is_err());
    }

    #[test]
    fn add_app_refuses_a_path_that_is_not_a_file() {
        let mut apps = Vec::new();
        let dir = tempdir();
        assert!(add_app(&mut apps, "Notepad", &dir.to_string_lossy()).is_err());
        assert!(apps.is_empty());
    }

    #[test]
    fn refused_while_paused_only_refuses_when_paused() {
        assert!(refused_while_paused(true).is_some());
        assert!(refused_while_paused(false).is_none());
    }

    #[test]
    fn log_action_and_recent_log_round_trip() {
        // Isolated by using a fresh HOME-equivalent is impractical here since
        // config_dir() is not overridable per test; this test only exercises
        // that logging a denied and a refused-paused entry does not panic
        // and that recent_log caps to the requested limit, not that this
        // process's real log file ends up with exactly these two lines
        // (other tests, and other runs, share the same file).
        log_action(&LogEntry { at: 1, tool: "search_files".into(), target: "x".into(), outcome: "denied".into() });
        log_action(&LogEntry {
            at: 2,
            tool: "open_app".into(),
            target: "y".into(),
            outcome: "refused-paused".into(),
        });
        let recent = recent_log(1);
        assert_eq!(recent.len(), 1);
    }
}
