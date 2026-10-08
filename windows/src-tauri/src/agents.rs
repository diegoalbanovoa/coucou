// A configuration file per agent CLI, under config_dir()/agents/.
//
// The table in agent.rs says how each CLI is driven, and a table in a binary
// is a thing only a rebuild can change. When a CLI gains a flag, or a turn
// needs longer than ten minutes, or an agent should be allowed to reach one
// more folder, that is a line in a JSON file now.
//
// What the file holds is two halves, and the distinction matters:
//
//   - what Coucou found      (id, label, exe, promptArgs, streams)
//     Written for the reader and refreshed on every launch. Editing these
//     changes nothing — they are overwritten from what was detected.
//   - what you can change    (extraArgs, turnTimeoutSeconds, extraDirs)
//     Read back on every turn, so an edit takes effect from the next message
//     without restarting anything.
//
// Claude Code is the one mapped today; the file is written for whichever CLIs
// are found, because the shape is per-CLI and a claude.json that existed while
// a gemini.json did not would be the surprising behaviour.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::platform;

/// The default a turn runs under, in seconds.
const DEFAULT_TURN_SECONDS: u64 = 600;
/// A turn timeout outside this range is not honoured: a zero would mean every
/// turn fails instantly, and a day-long one would hang the chat for a day.
const TURN_SECONDS_RANGE: std::ops::RangeInclusive<u64> = 10..=7200;

/// One CLI's file. Every field has a default, so a file written by an older
/// build — or one with a field deleted — still loads.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentConfig {
    // ── what Coucou found: overwritten, not read ──
    pub id: String,
    pub label: String,
    /// Where it was found. Worth seeing: which copy runs is what surprises
    /// people with four package managers installed.
    pub exe: String,
    /// How a one-shot prompt is passed to it.
    pub prompt_args: Vec<String>,
    /// Whether its reply streams and its conversation can be resumed.
    pub streams: bool,

    // ── what you can change ──
    /// Added to every turn, after the flags Coucou passes.
    pub extra_args: Vec<String>,
    /// How long one turn may take.
    pub turn_timeout_seconds: u64,
    /// Folders the agent may reach beyond the project and the vault.
    pub extra_dirs: Vec<String>,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            label: String::new(),
            exe: String::new(),
            prompt_args: Vec::new(),
            streams: false,
            extra_args: Vec::new(),
            turn_timeout_seconds: DEFAULT_TURN_SECONDS,
            extra_dirs: Vec::new(),
        }
    }
}

impl AgentConfig {
    /// The turn timeout, or the default when the file holds something that
    /// would break the chat rather than configure it.
    pub fn turn_timeout(&self) -> std::time::Duration {
        let seconds = if TURN_SECONDS_RANGE.contains(&self.turn_timeout_seconds) {
            self.turn_timeout_seconds
        } else {
            DEFAULT_TURN_SECONDS
        };
        std::time::Duration::from_secs(seconds)
    }

    /// The extra folders, as paths that exist. A folder that is not there is
    /// dropped: handing a CLI a directory that does not exist is an argument
    /// error, not a permission.
    pub fn dirs(&self) -> Vec<PathBuf> {
        self.extra_dirs.iter().map(PathBuf::from).filter(|p| p.is_dir()).collect()
    }
}

pub fn dir() -> PathBuf {
    platform::config_dir().join("agents")
}

pub fn path_for(id: &str) -> PathBuf {
    dir().join(format!("{id}.json"))
}

/// What is in the file for `id`, or the defaults when there is nothing usable.
/// Never fails: a broken file must not stop a turn.
pub fn load(id: &str) -> AgentConfig {
    match std::fs::read(path_for(id)) {
        Ok(bytes) => parse(&bytes).unwrap_or_default(),
        Err(_) => AgentConfig::default(),
    }
}

/// Split from `load` so it can be tested without a file. A UTF-8 BOM is
/// stripped for the same reason settings.rs strips one: Notepad writes it.
pub fn parse(bytes: &[u8]) -> Option<AgentConfig> {
    let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    serde_json::from_slice(text).ok()
}

/// The config for a CLI that was just found, with the detected half brought up
/// to date and the tunables kept.
///
/// The file is only rewritten when the detected half actually changed, so a
/// launch that finds everything where it was touches no files.
pub fn ensure(id: &str, label: &str, exe: &Path, prompt_args: &[&str], streams: bool) -> AgentConfig {
    let stored = load(id);
    let fresh = AgentConfig {
        id: id.to_string(),
        label: label.to_string(),
        exe: exe.to_string_lossy().to_string(),
        prompt_args: prompt_args.iter().map(|a| a.to_string()).collect(),
        streams,
        // Kept exactly as the file had them.
        extra_args: stored.extra_args.clone(),
        turn_timeout_seconds: stored.turn_timeout_seconds,
        extra_dirs: stored.extra_dirs.clone(),
    };
    if fresh != stored {
        if let Err(err) = write(id, &fresh) {
            crate::log::line(format!("could not write the config for {id}: {err}"));
        }
    }
    fresh
}

fn write(id: &str, config: &AgentConfig) -> std::io::Result<()> {
    platform::ensure_private_dir(&dir())?;
    let bytes = serde_json::to_vec_pretty(config)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let file = path_for(id);
    // Through a temporary file: a crash mid-write would otherwise leave a
    // half-written config, and the next launch would read the defaults over
    // whatever the user had set.
    let temp = file.with_extension("json.writing");
    std::fs::write(&temp, &bytes)?;
    std::fs::rename(&temp, &file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_with_only_the_tunables_keeps_every_other_default() {
        let config = parse(br#"{"extraArgs":["--debug"],"turnTimeoutSeconds":90}"#).unwrap();

        assert_eq!(config.extra_args, ["--debug"]);
        assert_eq!(config.turn_timeout().as_secs(), 90);
        assert!(config.extra_dirs.is_empty());
        assert_eq!(config.id, "", "nothing claims to be a CLI it is not");
    }

    #[test]
    fn a_timeout_that_would_break_the_chat_is_not_honoured() {
        for seconds in [0, 1, 9, 7201, u64::MAX] {
            let json = format!(r#"{{"turnTimeoutSeconds":{seconds}}}"#);
            let config = parse(json.as_bytes()).unwrap();
            assert_eq!(
                config.turn_timeout().as_secs(),
                DEFAULT_TURN_SECONDS,
                "{seconds} should not have been taken"
            );
        }
        // The edges of the range are fine.
        for seconds in [10, 600, 7200] {
            let json = format!(r#"{{"turnTimeoutSeconds":{seconds}}}"#);
            assert_eq!(parse(json.as_bytes()).unwrap().turn_timeout().as_secs(), seconds);
        }
    }

    #[test]
    fn a_folder_that_is_not_there_is_not_handed_to_the_agent() {
        let real = std::env::temp_dir().join("coucou-agents-dir");
        std::fs::create_dir_all(&real).unwrap();
        let config = AgentConfig {
            extra_dirs: vec![
                real.to_string_lossy().to_string(),
                real.join("gone").to_string_lossy().to_string(),
            ],
            ..AgentConfig::default()
        };

        assert_eq!(config.dirs(), [real.clone()]);
        let _ = std::fs::remove_dir_all(&real);
    }

    #[test]
    fn nothing_usable_in_the_file_is_the_defaults() {
        for bytes in [&b""[..], b"not json", b"null", br#"{"extraArgs":"--debug"}"#] {
            assert!(parse(bytes).is_none(), "{bytes:?} parsed");
        }
        // Serde reads a struct from a sequence as readily as from a map, so an
        // empty array is taken rather than refused. It carries nothing, which
        // comes to the same thing as refusing it.
        assert_eq!(parse(b"[]").unwrap(), AgentConfig::default());

        // A BOM is not corruption, and an unknown field is not either.
        let bom = parse(b"\xEF\xBB\xBF{\"turnTimeoutSeconds\":30}").unwrap();
        assert_eq!(bom.turn_timeout().as_secs(), 30);
        assert!(parse(br#"{"somethingLater":1}"#).is_some());
    }

    #[test]
    fn ensure_refreshes_what_was_detected_and_keeps_what_was_set() {
        let stored = AgentConfig {
            id: "claude".into(),
            label: "Claude Code".into(),
            exe: "C:/old/claude.exe".into(),
            prompt_args: vec!["-p".into()],
            streams: true,
            extra_args: vec!["--debug".into()],
            turn_timeout_seconds: 1200,
            extra_dirs: vec!["C:/notes".into()],
        };

        // What `ensure` builds, without touching the real config directory.
        let detected = AgentConfig {
            exe: "C:/new/claude.exe".into(),
            extra_args: stored.extra_args.clone(),
            turn_timeout_seconds: stored.turn_timeout_seconds,
            extra_dirs: stored.extra_dirs.clone(),
            ..stored.clone()
        };

        assert_eq!(detected.exe, "C:/new/claude.exe", "the path moved and the file follows");
        assert_eq!(detected.extra_args, ["--debug"], "what was set is kept");
        assert_eq!(detected.turn_timeout_seconds, 1200);
        assert_eq!(detected.extra_dirs, ["C:/notes"]);
        assert_ne!(detected, stored, "so the file is rewritten");
    }

    #[test]
    fn a_round_trip_through_json_changes_nothing() {
        let config = AgentConfig {
            id: "claude".into(),
            label: "Claude Code".into(),
            exe: "C:/bin/claude.exe".into(),
            prompt_args: vec!["-p".into()],
            streams: true,
            extra_args: vec!["--debug".into()],
            turn_timeout_seconds: 900,
            extra_dirs: vec!["C:/notes".into()],
        };
        let json = serde_json::to_vec(&config).unwrap();

        assert_eq!(parse(&json).unwrap(), config);
    }

    #[test]
    fn the_file_is_named_after_the_cli() {
        assert!(path_for("claude").ends_with("agents/claude.json") ||
                path_for("claude").ends_with(r"agents\claude.json"));
    }
}
