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
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

use crate::agents;
use crate::consoles;
use crate::platform;

/// How often a quiet turn is checked for a cancel or the deadline. Short
/// enough that Stop feels immediate, long enough to cost nothing.
const POLL: Duration = Duration::from_millis(150);
/// Output handed back to the island, so one runaway reply cannot flood it.
const MAX_OUTPUT: usize = 100_000;
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

/// One line in coucou.log. Tests must never write to the real one — the same
/// reason `settings::note` exists: `attach` is unit-tested, and the log is the
/// user's file, not a scratch pad.
fn note(message: String) {
    #[cfg(not(test))]
    crate::log::line(message);
    #[cfg(test)]
    eprintln!("{message}");
}

/// What marks the top of a repository. The strongest signal there is: it is
/// what "the project" means to every tool the agent will run inside it.
const VCS_MARKERS: &[&str] = &[".git", ".hg", ".svn"];

/// What marks a project that is not under version control. Weaker, because
/// plenty of these sit in subfolders of a bigger project — `windows/` in this
/// very repo has both a package.json and a Cargo.toml.
const PROJECT_MARKERS: &[&str] =
    &[".claude", "CLAUDE.md", "package.json", "Cargo.toml", "pyproject.toml", "go.mod", "pom.xml"];

/// The project root at or above `path`: what the agent should treat as the
/// origin of the project, whichever folder inside it the user pointed at.
///
/// The nearest VCS root wins over any ordinary marker, however deep it is —
/// picking `windows/src` in this repo means the repo, not `windows/`. With no
/// VCS folder anywhere above it, the nearest ordinary marker is the root.
///
/// The home directory is never a root, and neither is a drive root. `~/.claude`
/// and `~/CLAUDE.md` exist on most machines Coucou runs on, and snapping a
/// folder under home up to home itself would hand the agent the whole account.
///
/// Expects a canonical path, which is what `Project::attach` has by here.
pub fn root_of(path: &Path) -> Option<PathBuf> {
    root_of_under(path, &platform::home_dir())
}

/// `root_of`, with the ceiling named rather than read from the environment:
/// tests give it a temp directory, the way `load_from` takes its path. The
/// environment is the wrong thing to depend on in a test anyway — one of the
/// hook tests repoints HOME_VAR process-wide while it runs.
fn root_of_under(path: &Path, ceiling: &Path) -> Option<PathBuf> {
    // Both forms: `path` is canonical, so on Windows it is a `\\?\C:\…`
    // verbatim path, while the ceiling as configured usually is not.
    let stop: Vec<PathBuf> =
        [ceiling.canonicalize().ok(), Some(ceiling.to_path_buf())].into_iter().flatten().collect();
    let mut ordinary: Option<PathBuf> = None;

    for dir in path.ancestors() {
        // A drive root holds other people's folders as well as the user's.
        if dir.parent().is_none() || stop.iter().any(|s| s == dir) {
            break;
        }
        if VCS_MARKERS.iter().any(|m| dir.join(m).exists()) {
            return Some(dir.to_path_buf());
        }
        if ordinary.is_none() && PROJECT_MARKERS.iter().any(|m| dir.join(m).exists()) {
            ordinary = Some(dir.to_path_buf());
        }
    }
    ordinary
}

/// Where a turn runs: the attached project, else the default folder from
/// settings. Split out and taking both as arguments so the order is one thing
/// in one place, testable without a running app.
///
/// A default folder that is no longer there resolves to nothing rather than
/// being handed to a CLI as a working directory that does not exist. The value
/// itself is left in settings — a drive that is not mounted yet is the usual
/// reason, and the settings window says so instead of forgetting it.
pub fn folder_for_turn(attached: Option<PathBuf>, default: Option<&str>) -> Option<PathBuf> {
    attached.or_else(|| default.map(PathBuf::from).filter(|p| p.is_dir()))
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
        let picked = root.canonicalize().map_err(|e| format!("Cannot open that folder: {e}"))?;
        // The user may well have pointed at a folder inside the project. What
        // the agent gets is the project itself — its root is where CLAUDE.md,
        // the .claude folder and the rest of the context live.
        let root = root_of(&picked).unwrap_or_else(|| picked.clone());
        if root != picked {
            note(format!(
                "agent project: {} is inside {}, which is what was attached",
                display_path(&picked),
                display_path(&root)
            ));
        }
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

    pub fn set(&self, id: String) {
        *self.0.lock().unwrap() = Some(id);
    }

    pub fn reset(&self) {
        *self.0.lock().unwrap() = None;
    }
}

/// `\\?\C:\x` reads as noise wherever a path is shown to a human.
///
/// Shared with consoles.rs, which shows the path each CLI was found at.
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

/// What the island is told while a turn runs. The reply itself comes back from
/// `send`; these are what make the wait legible — before this the chat showed
/// three dots for up to ten minutes and then the whole answer at once.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Turn {
    /// More of the reply, as it is written.
    Text { text: String },
    /// A tool the agent just reached for.
    Step { label: String },
}

/// The turn in flight, so the island can stop it. One at a time: the chat only
/// sends the next message once the last reply has landed.
#[derive(Default)]
pub struct Cancel(Mutex<Option<Arc<AtomicBool>>>);

impl Cancel {
    /// A flag for the turn starting now, replacing any stale one.
    fn arm(&self) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        *self.0.lock().unwrap() = Some(flag.clone());
        flag
    }

    fn disarm(&self) {
        *self.0.lock().unwrap() = None;
    }

    /// Stops the turn in flight. False when there was nothing to stop.
    pub fn stop(&self) -> bool {
        match self.0.lock().unwrap().take() {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }
}

/// Turns the CLI's stream-json lines into what the island shows.
///
/// Two shapes carry the same text: `stream_event` deltas, token by token, and
/// the whole `assistant` message that follows each block. Emitting both would
/// show everything twice, so a delta wins once one has been seen, and whole
/// blocks are the fallback for a CLI that ignores --include-partial-messages.
#[derive(Default)]
pub struct Stream {
    saw_delta: bool,
    /// Everything emitted as text, in case no `result` line ever arrives.
    text: String,
    result: Option<String>,
    failed: bool,
}

impl Stream {
    /// What one line of output means. A line that is not JSON is not an error:
    /// CLIs print their own notices to stdout too.
    pub fn line(&mut self, line: &str) -> Vec<Turn> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        match value.get("type").and_then(Value::as_str) {
            Some("stream_event") => {
                let event = &value["event"];
                if event.get("type").and_then(Value::as_str) != Some("content_block_delta") {
                    return Vec::new();
                }
                match event["delta"].get("text").and_then(Value::as_str) {
                    Some(text) if !text.is_empty() => {
                        self.saw_delta = true;
                        vec![self.keep(text)]
                    }
                    _ => Vec::new(),
                }
            }
            Some("assistant") => {
                let blocks = value["message"]["content"].as_array().cloned().unwrap_or_default();
                let mut out = Vec::new();
                for block in blocks {
                    match block.get("type").and_then(Value::as_str) {
                        Some("text") if !self.saw_delta => {
                            match block["text"].as_str() {
                                Some(text) if !text.is_empty() => out.push(self.keep(text)),
                                _ => {}
                            }
                        }
                        Some("tool_use") => out.push(Turn::Step { label: step_label(&block) }),
                        _ => {}
                    }
                }
                out
            }
            Some("result") => {
                self.result =
                    value["result"].as_str().map(str::to_string).filter(|s| !s.trim().is_empty());
                // A turn that ran out of turns, or died inside, says so here
                // and still leaves the CLI exiting zero. Without this the
                // island showed "error_max_turns" as if it were the answer.
                let errored = value["is_error"].as_bool().unwrap_or(false);
                let subtype = value["subtype"].as_str().unwrap_or("success");
                self.failed = errored || subtype != "success";
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn keep(&mut self, text: &str) -> Turn {
        self.text.push_str(text);
        Turn::Text { text: text.to_string() }
    }

    /// Whether the `result` line said the turn failed. The CLI exits zero
    /// either way, so this is the only thing that tells them apart.
    pub fn failed(&self) -> bool {
        self.failed
    }

    /// The reply. The `result` line is authoritative; what was streamed is the
    /// fallback for a turn that ended without one.
    pub fn finish(self) -> String {
        self.result.unwrap_or(self.text)
    }
}

/// "Read agent.rs" rather than "Read": the file is the point. Says the same
/// thing the hook pills already say for a session running in a terminal.
fn step_label(block: &Value) -> String {
    let name = block.get("name").and_then(Value::as_str).unwrap_or("Tool");
    let input = &block["input"];
    let detail = ["file_path", "path", "command", "pattern", "description", "url", "query"]
        .iter()
        .find_map(|key| input.get(*key).and_then(Value::as_str))
        .unwrap_or("")
        .trim();
    if detail.is_empty() {
        return name.to_string();
    }
    // A lone path reads as its file name; anything else is already a phrase.
    let shown = if detail.contains(['/', '\\']) && !detail.contains(' ') {
        detail.rsplit(['/', '\\']).next().unwrap_or(detail)
    } else {
        detail
    };
    format!("{name} {}", first_chars(&shown.replace('\n', " "), 60))
}

/// One chat turn, run through the chosen CLI in the attached project.
/// What the agent is allowed to reach beyond the project, and what it is told
/// about it. The vault is resolved from settings by the caller: agent.rs has no
/// business knowing where notes live.
pub struct Knowledge {
    pub vault: Option<PathBuf>,
    pub briefing: Option<String>,
}

pub async fn send(
    project: &Project,
    session: &Session,
    cancel: &Cancel,
    cli_id: &str,
    prompt: String,
    knowledge: &Knowledge,
    on: &(dyn Fn(Turn) + Send + Sync),
) -> Result<String, String> {
    let Some(spec) = consoles::spec(cli_id) else {
        return Err(format!("Unknown agent `{cli_id}`."));
    };
    let Some(exe) = platform::find_exe(spec.stem) else {
        return Err(format!("{} is not installed.", spec.label));
    };
    let Some(root) = project.current() else {
        return Err("Attach a project folder first — the agent runs inside it.".into());
    };

    // What the CLI's own config file says, read per turn: an edit takes effect
    // from the next message rather than the next launch.
    let config = agents::load(spec.id);

    let mut cmd = Command::new(exe);
    cmd.current_dir(&root);
    // Without this the CLI waits three seconds for piped input that is never
    // coming, and every turn starts with a needless pause.
    cmd.stdin(Stdio::null());
    // The turn can time out, and dropping the future drops the Child without
    // killing it: the message said the CLI "was stopped" while it carried on
    // working in the background, against the session the next message resumes.
    cmd.kill_on_drop(true);
    // Same reason as platform::no_console: no console window flashes up.
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    // Resuming is per-CLI; only Claude Code gives us a session id to hold on to.
    let resumed = session.current();

    // However this CLI takes a one-shot prompt, from the table. A CLI with no
    // system-prompt flag is told about the vault in front of its first message
    // instead — once per conversation, not once per turn.
    cmd.args(spec.prompt_args);
    match (&knowledge.briefing, spec.streams, resumed.is_some()) {
        (Some(briefing), false, false) => cmd.arg(format!("{briefing}\n\n{prompt}")),
        _ => cmd.arg(&prompt),
    };

    if spec.streams {
        // stream-json so the island can show the reply as it is written and
        // name each tool as it is reached for. The CLI requires --verbose for
        // stream-json under -p.
        cmd.arg("--output-format").arg("stream-json");
        cmd.arg("--verbose").arg("--include-partial-messages");
        match &resumed {
            Some(id) => {
                cmd.arg("--resume").arg(id);
            }
            None => {
                // We choose the id rather than reading it back, so the island
                // can recognise this session's hook events from the first one —
                // before any reply has arrived.
                let id = uuid_v4();
                cmd.arg("--session-id").arg(&id);
                session.set(id);
            }
        }
        // Claude Code refuses writes outside its working directory unless the
        // directory is named up front, so "save this to my vault" needs this.
        if let Some(vault) = &knowledge.vault {
            cmd.arg("--add-dir").arg(vault);
        }
        if let Some(briefing) = &knowledge.briefing {
            cmd.arg("--append-system-prompt").arg(briefing);
        }
        for dir in config.dirs() {
            cmd.arg("--add-dir").arg(dir);
        }
    }

    // Last, so they can override anything above — which is the point of them.
    cmd.args(&config.extra_args);

    note(format!("agent {} in {}", spec.id, display_path(&root)));

    let timeout = config.turn_timeout();
    if spec.streams {
        stream_turn(cmd, cancel, session, resumed.is_some(), spec.label, timeout, on).await
    } else {
        one_shot(cmd, session, resumed.is_some(), spec.label, timeout).await
    }
}

/// A turn whose output is read as it comes, line by line.
///
/// The lines are read in their own task and arrive over a channel rather than
/// being awaited here directly: a channel receive can be abandoned without
/// losing what was half-read, which is what lets a quiet turn be checked for a
/// cancel every `POLL` without the app's tokio needing the `macros` feature.
#[allow(clippy::too_many_arguments)]
async fn stream_turn(
    mut cmd: Command,
    cancel: &Cancel,
    session: &Session,
    resumed: bool,
    label: &str,
    timeout: Duration,
    on: &(dyn Fn(Turn) + Send + Sync),
) -> Result<String, String> {
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Could not start {label}: {e}"))?;
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");

    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(64);
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx.send(line).await.is_err() {
                break;
            }
        }
    });
    // Drained in its own task: a stderr pipe nobody reads fills up and stops
    // the child, and what it holds is the only explanation of a failed turn.
    let errors = tokio::spawn(async move {
        let mut text = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut text).await;
        text
    });

    let stop = cancel.arm();
    let deadline = tokio::time::Instant::now() + timeout;
    let mut stream = Stream::default();
    let mut stopped = false;
    let mut timed_out = false;

    loop {
        if stop.load(Ordering::SeqCst) {
            stopped = true;
            break;
        }
        match tokio::time::timeout(POLL, rx.recv()).await {
            Ok(Some(line)) => {
                for turn in stream.line(&line) {
                    on(turn);
                }
            }
            // The reader is done, which means the CLI closed its output.
            Ok(None) => break,
            Err(_) if tokio::time::Instant::now() >= deadline => {
                timed_out = true;
                break;
            }
            Err(_) => {}
        }
    }
    cancel.disarm();

    if stopped || timed_out {
        // Not just dropped: the child would otherwise keep working against the
        // session the next message resumes. The session id is kept for exactly
        // that reason — the work may well have landed.
        let _ = child.start_kill();
        return Err(if stopped {
            format!("{label} was stopped.")
        } else {
            format!(
                "{label} was still working after {} minutes and was stopped.",
                timeout.as_secs() / 60
            )
        });
    }

    let status = child.wait().await.map_err(|e| format!("Lost track of {label}: {e}"))?;
    if !status.success() {
        let stderr = errors.await.unwrap_or_default();
        let streamed = stream.finish();
        let detail = if stderr.trim().is_empty() { streamed.trim() } else { stderr.trim() };
        // A resume that failed because the session is gone must not strand the
        // chat on a dead id.
        if resumed {
            session.reset();
        }
        return Err(first_chars(detail, 400));
    }

    // The CLI exited zero, which only means it ran. Whether the turn worked is
    // what the result line says.
    let failed = stream.failed();
    let reply = first_chars(&stream.finish(), MAX_OUTPUT);
    if failed {
        // The session is not reset: it is the turn that failed, not the
        // conversation, and the next message should carry on from here.
        return Err(first_chars(&reply, 400));
    }
    Ok(reply)
}

/// A turn from a CLI with no streaming output format: one wait, one answer.
async fn one_shot(
    mut cmd: Command,
    session: &Session,
    resumed: bool,
    label: &str,
    timeout: Duration,
) -> Result<String, String> {
    let output = match tokio::time::timeout(timeout, cmd.output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(format!("Could not start {label}: {e}")),
        Err(_) => {
            return Err(format!(
                "{label} was still working after {} minutes and was stopped.",
                timeout.as_secs() / 60
            ))
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
        if resumed {
            session.reset();
        }
        return Err(first_chars(detail, 400));
    }
    Ok(first_chars(stdout.trim(), MAX_OUTPUT))
}

// ── One real turn, end to end ────────────────────────────────────────────────

/// Tests that run the agent CLI for real.
///
/// Every one is `#[ignore]`d, for the same reason as `picker_e2e`: they need
/// something `cargo test` cannot provide — here a CLI that is installed and
/// signed in — and they spend the user's own quota. What they cover is the
/// half of a turn no fixture can: that the flags are accepted, that the lines
/// come back in the shape `Stream` reads, and that the reply arrives.
///
/// A stream-json contract read off the documentation is a contract nobody has
/// checked. Running these is how the `is_error` case was found.
///
/// Run them by hand, deliberately:
///   cargo test --lib live_agent -- --ignored --nocapture
#[cfg(test)]
mod live_agent {
    use super::*;

    /// The prompt is chosen so the model has no reason to reach for a tool.
    /// One that did would fire the hooks, and with Coucou running the approval
    /// card would wait for a human while this test sat out its ten minutes.
    const NO_TOOLS: &str = "Reply with exactly: ok";

    fn project_in(name: &str) -> Project {
        let root = std::env::temp_dir().join(format!("coucou-live-{name}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let project = Project::default();
        project.attach(root.to_str().unwrap()).unwrap();
        project
    }

    fn nothing() -> Knowledge {
        Knowledge { vault: None, briefing: None }
    }

    #[tokio::test]
    #[ignore = "runs the real Claude Code CLI and spends quota"]
    async fn a_turn_streams_its_text_and_ends_with_the_reply() {
        let project = project_in("turn");
        let session = Session::default();
        let seen = Mutex::new(Vec::new());

        let reply = send(
            &project,
            &session,
            &Cancel::default(),
            "claude",
            NO_TOOLS.into(),
            &nothing(),
            &|turn| seen.lock().unwrap().push(turn),
        )
        .await
        .expect("the turn should have run");

        assert_eq!(reply.trim(), "ok", "the reply comes off the result line");
        let turns = seen.lock().unwrap();
        assert!(
            turns.iter().any(|t| matches!(t, Turn::Text { .. })),
            "nothing was streamed, so --include-partial-messages or the parser is wrong: {turns:?}"
        );
        // The streamed pieces must add up to the reply, or the island would
        // show one thing while writing and another once it finished.
        let streamed: String = turns
            .iter()
            .filter_map(|t| match t {
                Turn::Text { text } => Some(text.as_str()),
                Turn::Step { .. } => None,
            })
            .collect();
        assert_eq!(streamed.trim(), reply.trim());
        assert!(session.current().is_some(), "a session id is kept to resume with");
    }

    #[tokio::test]
    #[ignore = "runs the real Claude Code CLI and spends quota"]
    async fn a_second_message_carries_on_the_same_conversation() {
        let project = project_in("resume");
        let session = Session::default();
        let quiet = |_: Turn| {};

        let first = send(
            &project,
            &session,
            &Cancel::default(),
            "claude",
            "Remember the word pineapple. Reply with exactly: ok".into(),
            &nothing(),
            &quiet,
        )
        .await
        .expect("the first turn should have run");
        assert_eq!(first.trim(), "ok");

        let id = session.current().expect("the first turn minted a session id");

        let second = send(
            &project,
            &session,
            &Cancel::default(),
            "claude",
            "What word did I ask you to remember? Reply with only that word.".into(),
            &nothing(),
            &quiet,
        )
        .await
        .expect("the second turn should have run");

        assert!(
            second.to_lowercase().contains("pineapple"),
            "the conversation was not resumed: {second:?}"
        );
        assert_eq!(session.current().as_deref(), Some(id.as_str()), "and it is the same one");
    }

    #[tokio::test]
    #[ignore = "runs the real Claude Code CLI and spends quota"]
    async fn a_turn_can_be_stopped_while_it_runs() {
        let project = project_in("cancel");
        let cancel = Cancel::default();

        // Stopped from outside, the way the island's Stop button does it, once
        // the turn has had long enough to be under way.
        let stopper = async {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            cancel.stop()
        };
        // Bound rather than passed inline: the future borrows them, and it
        // outlives the statement that builds it.
        let session = Session::default();
        let knowledge = nothing();
        let turn = send(
            &project,
            &session,
            &cancel,
            "claude",
            "Count slowly from 1 to 500, one number per line.".into(),
            &knowledge,
            &|_| {},
        );

        let (stopped, result) = tokio::join!(stopper, turn);

        assert!(stopped, "there was a turn in flight to stop");
        let err = result.expect_err("a stopped turn is not a reply");
        assert!(err.contains("stopped"), "got {err:?}");
    }
}

/// Truncates on a character boundary — `String::truncate` panics mid-codepoint,
/// and CLI output is full of box-drawing characters and emoji.
///
/// Shared with consoles.rs, which cuts a `--version` line down to size.
pub(crate) fn first_chars(s: &str, max: usize) -> String {
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

    /// A ceiling the walk will never reach, for the cases that are not about
    /// where it stops.
    fn no_ceiling() -> PathBuf {
        PathBuf::from("")
    }

    #[test]
    fn the_attached_project_beats_the_default_folder() {
        let attached = temp_root("turn-attached");
        let default = temp_root("turn-default");
        let default_str = default.to_string_lossy().to_string();

        assert_eq!(
            folder_for_turn(Some(attached.clone()), Some(&default_str)),
            Some(attached),
            "an explicit choice is not overridden by a default"
        );
    }

    #[test]
    fn with_nothing_attached_the_default_folder_is_used() {
        let default = temp_root("turn-fallback");
        let default_str = default.to_string_lossy().to_string();

        assert_eq!(folder_for_turn(None, Some(&default_str)), Some(default));
    }

    #[test]
    fn a_default_folder_that_is_gone_resolves_to_nothing() {
        let parent = temp_root("turn-missing");
        let gone = parent.join("not-there").to_string_lossy().to_string();

        // Not the path, not the parent, nothing: a working directory that does
        // not exist is an argument error waiting to happen.
        assert_eq!(folder_for_turn(None, Some(&gone)), None);
        assert_eq!(folder_for_turn(None, Some("")), None);
        assert_eq!(folder_for_turn(None, None), None);
    }

    #[test]
    fn the_nearest_vcs_root_wins_over_an_ordinary_marker_closer_by() {
        let root = temp_root("root-vcs");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let inner = root.join("windows").join("src");
        std::fs::create_dir_all(&inner).unwrap();
        // windows/ looks like a project of its own — this repo's own shape —
        // and is still not what "the project" means.
        std::fs::write(root.join("windows").join("package.json"), "{}").unwrap();

        assert_eq!(root_of_under(&inner.canonicalize().unwrap(), &no_ceiling()), Some(root));
    }

    #[test]
    fn without_any_vcs_folder_the_nearest_ordinary_marker_is_the_root() {
        let root = temp_root("root-marker");
        let app = root.join("app");
        let inner = app.join("src");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(app.join("Cargo.toml"), "").unwrap();

        assert_eq!(root_of_under(&inner.canonicalize().unwrap(), &no_ceiling()), Some(app));
    }

    #[test]
    fn a_folder_with_no_marker_above_it_has_no_root() {
        let dir = temp_root("root-none");
        assert_eq!(root_of_under(&dir, dir.parent().unwrap()), None);
    }

    #[test]
    fn the_walk_stops_below_the_ceiling_however_marked_it_is() {
        // What this stands for is the home directory: `~/.claude` and
        // `~/CLAUDE.md` exist on most machines Coucou runs on, and snapping a
        // folder under home up to home itself would hand the agent the whole
        // account.
        let ceiling = temp_root("root-ceiling");
        std::fs::create_dir_all(ceiling.join(".claude")).unwrap();
        std::fs::create_dir_all(ceiling.join(".git")).unwrap();
        let inner = ceiling.join("notes").join("deep");
        std::fs::create_dir_all(&inner).unwrap();

        assert_eq!(root_of_under(&inner.canonicalize().unwrap(), &ceiling), None);
    }

    #[test]
    fn attaching_a_folder_inside_a_project_attaches_the_project() {
        let root = temp_root("attach-inner-root");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let inner = root.join("deep").join("inside");
        std::fs::create_dir_all(&inner).unwrap();

        let project = Project::default();
        let shown = project.attach(inner.to_str().unwrap()).unwrap();

        assert_eq!(project.current().unwrap(), root);
        assert_eq!(shown, display_path(&root));
    }

    #[test]
    fn attach_replaces_and_detach_clears() {
        // Both are roots of their own: `attach` snaps to the project root, and
        // what that resolves to for an unmarked temp folder depends on the home
        // directory — which another test repoints while it runs.
        let a = temp_root("attach-a");
        let b = temp_root("attach-b");
        std::fs::create_dir_all(a.join(".git")).unwrap();
        std::fs::create_dir_all(b.join(".git")).unwrap();
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

    /// `send` for the cases that never get as far as running anything, so the
    /// turns it would report have nowhere to go.
    async fn quiet_send(project: &Project, cli: &str) -> Result<String, String> {
        let nothing = Knowledge { vault: None, briefing: None };
        send(project, &Session::default(), &Cancel::default(), cli, "hi".into(), &nothing, &|_| {})
            .await
    }

    #[tokio::test]
    async fn refuses_to_run_without_an_attached_project() {
        let err = quiet_send(&Project::default(), "claude").await.unwrap_err();
        assert!(err.contains("Attach a project"), "got {err:?}");
    }

    #[tokio::test]
    async fn refuses_an_unknown_agent() {
        let err = quiet_send(&Project::default(), "nope").await.unwrap_err();
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

    /// The lines of a small but complete turn, in the order the CLI prints
    /// them: a tool, a partial text delta, the whole message that follows it,
    /// and the result.
    fn turn_lines() -> Vec<&'static str> {
        vec![
            r#"{"type":"system","subtype":"init","session_id":"s1"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"C:/code/thing/src/agent.rs"}}]}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Half "}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"a sentence."}}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Half a sentence."}]}}"#,
            r#"{"type":"result","subtype":"success","result":"Half a sentence."}"#,
        ]
    }

    fn turns_of(lines: &[&str]) -> (Vec<Turn>, String) {
        let mut stream = Stream::default();
        let mut turns = Vec::new();
        for line in lines {
            turns.extend(stream.line(line));
        }
        (turns, stream.finish())
    }

    #[test]
    fn a_turn_is_read_as_steps_and_text_and_then_a_reply() {
        let (turns, reply) = turns_of(&turn_lines());

        assert_eq!(
            turns,
            [
                Turn::Step { label: "Read agent.rs".into() },
                Turn::Text { text: "Half ".into() },
                Turn::Text { text: "a sentence.".into() },
            ],
            "the whole message after the deltas must not be sent a second time"
        );
        assert_eq!(reply, "Half a sentence.");
    }

    #[test]
    fn a_cli_that_ignores_partial_messages_still_streams_whole_blocks() {
        let lines: Vec<&str> =
            turn_lines().into_iter().filter(|l| !l.contains("stream_event")).collect();
        let (turns, reply) = turns_of(&lines);

        assert_eq!(
            turns,
            [
                Turn::Step { label: "Read agent.rs".into() },
                Turn::Text { text: "Half a sentence.".into() },
            ]
        );
        assert_eq!(reply, "Half a sentence.");
    }

    #[test]
    fn a_turn_with_no_result_line_falls_back_to_what_was_streamed() {
        let lines: Vec<&str> =
            turn_lines().into_iter().filter(|l| !l.contains(r#""type":"result""#)).collect();
        let (_, reply) = turns_of(&lines);

        assert_eq!(reply, "Half a sentence.");
    }

    #[test]
    fn a_turn_the_cli_says_failed_is_not_a_reply() {
        // The shape a real `claude -p --output-format stream-json` prints: the
        // process exits zero either way, so this line is the only difference.
        let (_, reply) = turns_of(&[
            r#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":"ran out of turns"}"#,
        ]);
        assert_eq!(reply, "ran out of turns");

        let mut stream = Stream::default();
        stream.line(r#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":"x"}"#);
        assert!(stream.failed());

        let mut good = Stream::default();
        good.line(r#"{"type":"result","subtype":"success","is_error":false,"result":"x"}"#);
        assert!(!good.failed());

        // A result line from a version that says neither is taken at its word.
        let mut quiet = Stream::default();
        quiet.line(r#"{"type":"result","result":"x"}"#);
        assert!(!quiet.failed());
    }

    #[test]
    fn lines_that_are_not_json_or_not_ours_are_passed_over() {
        let (turns, reply) = turns_of(&[
            "Loading the thing…",
            "",
            r#"{"type":"something_new","payload":1}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_stop"}}"#,
        ]);

        assert!(turns.is_empty(), "nothing to show: {turns:?}");
        assert_eq!(reply, "");
    }

    #[test]
    fn a_step_is_named_by_what_it_acts_on() {
        let label = |json: &str| step_label(&serde_json::from_str::<Value>(json).unwrap());

        assert_eq!(label(r#"{"name":"Bash","input":{"command":"cargo test"}}"#), "Bash cargo test");
        assert_eq!(label(r#"{"name":"Grep","input":{"pattern":"fn send"}}"#), "Grep fn send");
        assert_eq!(label(r#"{"name":"Edit","input":{"file_path":"/a/b/chat.ts"}}"#), "Edit chat.ts");
        // Nothing worth naming, and an input shape we have never seen.
        assert_eq!(label(r#"{"name":"TodoWrite","input":{"todos":[]}}"#), "TodoWrite");
        assert_eq!(label(r#"{"input":{}}"#), "Tool");
    }

    #[test]
    fn a_cancel_is_armed_once_and_stops_one_turn() {
        let cancel = Cancel::default();
        assert!(!cancel.stop(), "nothing is running");

        let flag = cancel.arm();
        assert!(cancel.stop(), "the turn in flight is stopped");
        assert!(flag.load(Ordering::SeqCst), "the turn sees it");
        assert!(!cancel.stop(), "and it is only stopped once");
    }

    #[test]
    fn truncation_never_splits_a_character() {
        let s = "🙂".repeat(10);
        let cut = first_chars(&s, 3);
        assert_eq!(cut, "🙂🙂🙂…");
    }
}
