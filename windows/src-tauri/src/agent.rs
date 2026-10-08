// The island chat, run through the agent CLIs already installed on this
// machine — Claude Code first among them.
//
// The alternative was our own tool loop against the Anthropic API, which would
// need an API key, reimplement a worse version of tools the CLI already has,
// and know nothing about the user's CLAUDE.md. Shelling out to `claude -p`
// instead means the chat gets the real agent: the user's own subscription,
// every tool Claude Code ships, their skills and MCP servers, and their
// CLAUDE.md — including, for this user, where the Obsidian vault lives.
//
// Permissions come for free and are the nicest part: the session we spawn runs
// the hooks in ~/.claude/settings.json, so its PreToolUse/PermissionRequest
// events reach Coucou through coucou-hook and the named pipe like any other
// session, and the island shows its existing Allow / Deny card. Headless mode
// has no terminal to fall back on, so the island is the only thing that can
// answer — which is exactly the point.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::log;
use crate::platform;

/// A whole agent turn can take a while — a real task runs many tools.
const TURN_TIMEOUT: Duration = Duration::from_secs(600);
/// Output handed back to the island, so one runaway reply cannot flood it.
const MAX_OUTPUT: usize = 100_000;

/// One agent CLI we know how to drive headlessly.
pub struct Cli {
    /// Stable id, also the value stored in settings.
    pub id: &'static str,
    pub label: &'static str,
    /// Executable stem to look for on PATH.
    stem: &'static str,
}

/// Every CLI Coucou can run. Claude Code is first: it is the one whose hooks
/// Coucou already installs, so it is the only one whose tool calls can be
/// approved from the island today.
pub const CLIS: &[Cli] = &[
    Cli { id: "claude", label: "Claude Code", stem: "claude" },
    Cli { id: "gemini", label: "Gemini CLI", stem: "gemini" },
    Cli { id: "copilot", label: "Copilot CLI", stem: "copilot" },
];

fn cli(id: &str) -> Option<&'static Cli> {
    CLIS.iter().find(|c| c.id == id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInfo {
    pub id: &'static str,
    pub label: &'static str,
    /// Where it was found, for the settings window.
    pub path: String,
}

/// Which agent CLIs are actually installed. Looked up on demand rather than
/// cached: installing one should not need a restart to show up.
pub fn installed() -> Vec<CliInfo> {
    CLIS.iter()
        .filter_map(|c| {
            platform::find_on_path(c.stem).map(|p| CliInfo {
                id: c.id,
                label: c.label,
                path: p.to_string_lossy().to_string(),
            })
        })
        .collect()
}

// ── Slash commands ────────────────────────────────────────────────────────────

/// One `/thing` the user can send, for the island's autocomplete.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    /// Without the slash.
    pub name: String,
    pub description: String,
    /// "user", "project" or "skill" — where it came from.
    pub source: &'static str,
}

/// What `/` can reach in the current project.
///
/// These are read off disk rather than asked of the CLI: `claude` has no
/// headless "list my commands" flag, and the layout under ~/.claude is the
/// same thing its own autocomplete reads. Sending one is nothing special —
/// `/code-review` is passed through as the prompt and the CLI expands it.
pub fn slash_commands(project: &Project) -> Vec<SlashCommand> {
    let mut out = Vec::new();
    let home = platform::home_dir();

    collect_commands(&home.join(".claude").join("commands"), "user", &mut out);
    if let Some(root) = project.current() {
        collect_commands(&root.join(".claude").join("commands"), "project", &mut out);
    }

    // Skills are invoked the same way, and for this user they are most of the
    // list — leaving them out would make `/` look nearly empty.
    if let Ok(entries) = std::fs::read_dir(home.join(".claude").join("skills")) {
        for entry in entries.flatten().filter(|e| e.path().is_dir()) {
            let manifest = entry.path().join("SKILL.md");
            if !manifest.is_file() {
                continue;
            }
            out.push(SlashCommand {
                name: entry.file_name().to_string_lossy().to_string(),
                description: front_matter_description(&manifest),
                source: "skill",
            });
        }
    }

    out.sort_by(|a, b| a.name.cmp(&b.name));
    out.dedup_by(|a, b| a.name == b.name);
    out
}

fn collect_commands(dir: &Path, source: &'static str, out: &mut Vec<SlashCommand>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        out.push(SlashCommand {
            name: stem,
            description: front_matter_description(&path),
            source,
        });
    }
}

/// The `description:` line of a YAML front-matter block, if there is one.
/// A hand-rolled read rather than a YAML parser: one scalar field, and the
/// worst case is an empty description in a dropdown.
fn front_matter_description(path: &Path) -> String {
    let Ok(text) = std::fs::read_to_string(path) else { return String::new() };
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return String::new();
    }
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("description:") {
            return rest.trim().trim_matches(['"', '\'']).to_string();
        }
    }
    String::new()
}

/// The folder the agent works in. Nothing runs without one: a CLI with no
/// chosen working directory would quietly inherit Coucou's own, which is not
/// a project the user picked.
#[derive(Default)]
pub struct Project(Mutex<Option<PathBuf>>);

impl Project {
    pub fn attach(&self, path: &str) -> Result<String, String> {
        let root = PathBuf::from(path);
        if !root.is_dir() {
            return Err("That is not a folder.".into());
        }
        let root = root.canonicalize().map_err(|e| format!("Cannot open that folder: {e}"))?;
        let shown = display_path(&root);
        *self.0.lock().unwrap() = Some(root);
        Ok(shown)
    }

    pub fn detach(&self) {
        *self.0.lock().unwrap() = None;
    }

    pub fn current(&self) -> Option<PathBuf> {
        self.0.lock().unwrap().clone()
    }
}

/// The CLI session this chat is continuing, so a second message carries on the
/// same conversation instead of starting a new one. Also how the island tells
/// the session it started apart from one the user runs in their own terminal:
/// hook events carrying this id belong to the chat.
#[derive(Default)]
pub struct Session(Mutex<Option<String>>);

impl Session {
    pub fn current(&self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }

    fn set(&self, id: String) {
        *self.0.lock().unwrap() = Some(id);
    }

    pub fn reset(&self) {
        *self.0.lock().unwrap() = None;
    }
}

/// `\\?\C:\x` reads as noise wherever a path is shown to a human.
pub fn display_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

/// A v4 UUID from the OS random source. Only used for `--session-id`, which is
/// why this is twenty lines rather than another dependency.
fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("the OS always has randomness");
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 1
    let h = |r: &[u8]| r.iter().map(|x| format!("{x:02x}")).collect::<String>();
    format!("{}-{}-{}-{}-{}", h(&b[0..4]), h(&b[4..6]), h(&b[6..8]), h(&b[8..10]), h(&b[10..16]))
}

/// Extra folders the agent may touch beyond the attached project.
///
/// The Obsidian vault is here so "save this to my vault" works without
/// attaching the vault as the project: Claude Code refuses writes outside its
/// working directory unless the directory is named up front.
fn extra_dirs() -> Vec<PathBuf> {
    let vault = platform::home_dir().join("OneDrive").join("Documentos").join("Obsidian Vault");
    if vault.is_dir() { vec![vault] } else { Vec::new() }
}

/// One chat turn, run through the chosen CLI in the attached project.
pub async fn send(
    project: &Project,
    session: &Session,
    cli_id: &str,
    prompt: String,
) -> Result<String, String> {
    let Some(spec) = cli(cli_id) else {
        return Err(format!("Unknown agent `{cli_id}`."));
    };
    let Some(exe) = platform::find_on_path(spec.stem) else {
        return Err(format!("{} is not installed.", spec.label));
    };
    let Some(root) = project.current() else {
        return Err("Attach a project folder first — the agent runs inside it.".into());
    };

    let mut cmd = tokio::process::Command::new(exe);
    cmd.current_dir(&root);
    // Without this the CLI waits three seconds for piped input that is never
    // coming, and every turn starts with a needless pause.
    cmd.stdin(std::process::Stdio::null());
    // The turn can time out, and dropping the future drops the Child without
    // killing it: the message said the CLI "was stopped" while it carried on
    // working in the background, against the session the next message resumes.
    cmd.kill_on_drop(true);
    // Same reason as platform::no_console: no console window flashes up.
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    // Resuming is per-CLI; only Claude Code gives us a session id to hold on to.
    let resumed = session.current();
    match spec.id {
        "claude" => {
            cmd.arg("-p").arg(&prompt).arg("--output-format").arg("json");
            match &resumed {
                Some(id) => {
                    cmd.arg("--resume").arg(id);
                }
                None => {
                    // We choose the id rather than reading it back, so the
                    // island can recognise this session's hook events from the
                    // first one — before any reply has arrived.
                    let id = uuid_v4();
                    cmd.arg("--session-id").arg(&id);
                    session.set(id);
                }
            }
            for dir in extra_dirs() {
                cmd.arg("--add-dir").arg(dir);
            }
        }
        // The others have no session handle we can reuse, so each message is
        // its own turn. Said plainly in the UI rather than faked here.
        _ => {
            cmd.arg("-p").arg(&prompt);
        }
    }

    log::line(format!("agent {} in {}", spec.id, display_path(&root)));

    let output = match tokio::time::timeout(TURN_TIMEOUT, cmd.output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(format!("Could not start {}: {e}", spec.label)),
        Err(_) => {
            // The session id is kept: the work may well have landed, and the
            // next message should continue the same conversation.
            return Err(format!(
                "{} was still working after {} minutes and was stopped.",
                spec.label,
                TURN_TIMEOUT.as_secs() / 60
            ));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
        // A resume that fails because the session is gone must not strand the
        // chat on a dead id.
        if resumed.is_some() {
            session.reset();
        }
        return Err(first_chars(detail, 400));
    }

    Ok(first_chars(&extract_text(spec.id, &stdout), MAX_OUTPUT))
}

/// `--output-format json` wraps the reply; everything else prints it plainly.
fn extract_text(cli_id: &str, stdout: &str) -> String {
    if cli_id != "claude" {
        return stdout.trim().to_string();
    }
    match serde_json::from_str::<Value>(stdout) {
        Ok(v) => v
            .get("result")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| stdout.trim())
            .to_string(),
        // An older CLI, or a flag it did not honour: the raw text is still the
        // answer, and showing it beats showing an error.
        Err(_) => stdout.trim().to_string(),
    }
}

/// Truncates on a character boundary — `String::truncate` panics mid-codepoint,
/// and CLI output is full of box-drawing characters and emoji.
fn first_chars(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        None => s.to_string(),
        Some((i, _)) => format!("{}…", &s[..i]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("coucou-agent-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn attach_replaces_and_detach_clears() {
        let a = temp_root("attach-a");
        let b = temp_root("attach-b");
        let project = Project::default();
        assert!(project.current().is_none());

        project.attach(a.to_str().unwrap()).unwrap();
        assert_eq!(project.current().unwrap(), a);

        // Attaching a second folder replaces the first rather than adding to it.
        project.attach(b.to_str().unwrap()).unwrap();
        assert_eq!(project.current().unwrap(), b);

        project.detach();
        assert!(project.current().is_none());
    }

    #[test]
    fn attach_rejects_a_path_that_is_not_a_folder() {
        let root = temp_root("attach-bad");
        let file = root.join("a.txt");
        std::fs::write(&file, "x").unwrap();
        let project = Project::default();
        assert!(project.attach(file.to_str().unwrap()).is_err());
        assert!(project.attach(root.join("nope").to_str().unwrap()).is_err());
        assert!(project.current().is_none());
    }

    #[tokio::test]
    async fn refuses_to_run_without_an_attached_project() {
        let err = send(&Project::default(), &Session::default(), "claude", "hi".into())
            .await
            .unwrap_err();
        assert!(err.contains("Attach a project"), "got {err:?}");
    }

    #[tokio::test]
    async fn refuses_an_unknown_agent() {
        let err = send(&Project::default(), &Session::default(), "nope", "hi".into())
            .await
            .unwrap_err();
        assert!(err.contains("Unknown agent"), "got {err:?}");
    }

    #[test]
    fn a_session_is_remembered_then_forgotten() {
        let session = Session::default();
        assert!(session.current().is_none());
        session.set("abc".into());
        assert_eq!(session.current().unwrap(), "abc");
        session.reset();
        assert!(session.current().is_none());
    }

    #[test]
    fn uuids_look_like_uuids_and_differ() {
        let a = uuid_v4();
        let b = uuid_v4();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        assert_eq!(a.split('-').map(str::len).collect::<Vec<_>>(), vec![8, 4, 4, 4, 12]);
        // Version 4, variant 1.
        assert!(a.split('-').nth(2).unwrap().starts_with('4'), "{a}");
        let variant = a.split('-').nth(3).unwrap().chars().next().unwrap();
        assert!("89ab".contains(variant), "{a}");
    }

    #[test]
    fn claude_json_output_is_unwrapped() {
        let json = r#"{"type":"result","result":"Hello there.","session_id":"x"}"#;
        assert_eq!(extract_text("claude", json), "Hello there.");
    }

    #[test]
    fn output_that_is_not_json_is_shown_as_it_came() {
        assert_eq!(extract_text("claude", "  plain text  "), "plain text");
        assert_eq!(extract_text("gemini", "  plain text  "), "plain text");
    }

    #[test]
    fn truncation_never_splits_a_character() {
        let s = "🙂".repeat(10);
        let cut = first_chars(&s, 3);
        assert_eq!(cut, "🙂🙂🙂…");
    }
}
