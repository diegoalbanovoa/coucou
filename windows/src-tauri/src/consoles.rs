// Which agent consoles this machine has.
//
// Moved out of agent.rs, which had grown to hold three jobs at once: the table
// of CLIs and how to find them, the parsing of one turn's output, and the
// state of the conversation. Finding them is its own concern — it answers a
// question the island asks on every boot and every focus, and it answers it
// about the machine rather than about any conversation.
//
// What a console is, here: an agent CLI installed on this machine that Coucou
// knows how to drive headlessly. Not a shell, and not a terminal window —
// PowerShell has no turns to take and a Windows Terminal tab cannot be driven
// from outside. Live sessions are a separate matter and need nothing from this
// module: they arrive as hook events and the island already knows which
// terminal and folder each one is in.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

use crate::agent::{display_path, first_chars};
use crate::agents;
use crate::platform;

/// How long a CLI gets to answer `--version`. Generous because this does not
/// hold anything up: an npm shim starting cold took over three seconds on the
/// machine this was written on, and answered in two once warm.
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);

/// One agent CLI we know how to drive headlessly.
pub struct Cli {
    /// Stable id, also the value stored in settings.
    pub id: &'static str,
    pub label: &'static str,
    /// Executable stem to look for.
    pub(crate) stem: &'static str,
    /// The arguments that run one prompt and print the answer; the prompt is
    /// appended after them. Data rather than a match arm, because this is the
    /// one thing that differs between these CLIs and it is easy to get wrong.
    pub(crate) prompt_args: &'static [&'static str],
    /// Whether Coucou can read this one's output as it comes and resume its
    /// conversation. Only Claude Code, for now — it is the only one with both
    /// a streaming JSON format and a session id we can choose.
    pub streams: bool,
    /// Whether its tool calls can be approved from the island, which means
    /// whether Coucou installs its hooks.
    pub approvable: bool,
    /// Whether it has been run from Coucou on a real machine.
    pub verified: bool,
    /// The colour its Mochi wears.
    pub color: &'static str,
}

/// Every CLI Coucou can run.
///
/// Claude Code is first: it is the one whose hooks Coucou installs, so it is
/// the only one whose tool calls can be approved from the island.
///
/// Ollama is deliberately not here. It is a model runner, not an agent CLI: it
/// has no tools to approve, and `ollama run` needs a model named on the
/// command line, which is a choice this list has no way to make.
pub const CLIS: &[Cli] = &[
    Cli {
        id: "claude",
        label: "Claude Code",
        stem: "claude",
        prompt_args: &["-p"],
        streams: true,
        approvable: true,
        verified: true,
        color: "#F5F6F8",
    },
    Cli {
        id: "gemini",
        label: "Gemini CLI",
        stem: "gemini",
        prompt_args: &["-p"],
        streams: false,
        approvable: false,
        verified: true,
        color: "#4285F4",
    },
    Cli {
        id: "copilot",
        label: "Copilot CLI",
        stem: "copilot",
        prompt_args: &["-p"],
        streams: false,
        approvable: false,
        verified: true,
        color: "#8E7CC3",
    },
    Cli {
        id: "codex",
        label: "Codex CLI",
        stem: "codex",
        prompt_args: &["exec"],
        streams: false,
        approvable: false,
        verified: false,
        color: "#10A37F",
    },
    Cli {
        id: "cursor-agent",
        label: "Cursor Agent",
        stem: "cursor-agent",
        prompt_args: &["-p"],
        streams: false,
        approvable: false,
        verified: false,
        color: "#5B8DEF",
    },
    Cli {
        id: "qwen",
        label: "Qwen Code",
        stem: "qwen",
        prompt_args: &["-p"],
        streams: false,
        approvable: false,
        verified: false,
        color: "#A855F7",
    },
    Cli {
        id: "opencode",
        label: "OpenCode",
        stem: "opencode",
        prompt_args: &["run"],
        streams: false,
        approvable: false,
        verified: false,
        color: "#F5A524",
    },
];

/// The table entry for an id, or nothing when the id is not one of ours.
pub fn spec(id: &str) -> Option<&'static Cli> {
    CLIS.iter().find(|c| c.id == id)
}

/// What a console can do, said in three separate answers rather than one.
///
/// All three are Claude Code's today, and they are still three fields: they
/// are different claims, and the next CLI to gain a streaming JSON format
/// will not thereby gain hooks Coucou installs. The island shows them as
/// badges so the picker stops implying every CLI is equally capable.
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// Its reply can be read as it is written.
    pub streaming: bool,
    /// A second message carries on the same conversation.
    pub resume: bool,
    /// Its tool calls reach the island, so they can be approved there. True
    /// only where Coucou installs that CLI's hooks.
    pub approvable: bool,
}

/// One installed console, as the island and the settings window show it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Console {
    pub id: &'static str,
    pub label: &'static str,
    /// Where it was found. Worth showing: which copy is being run is exactly
    /// the thing that surprises people with four package managers installed.
    pub path: String,
    /// What it answers to `--version`, or empty when it did not answer.
    pub version: String,
    /// The colour its Mochi wears in the picker, so a console is recognisable
    /// before its name is read.
    pub color: &'static str,
    pub can: Capabilities,
    /// Whether this one has ever actually been run from Coucou, or whether it
    /// is driven the way its own documentation says. Four of the seven are the
    /// latter, and the picker says so rather than implying they all work.
    pub verified: bool,
    /// Its config file, so the settings window can point at it.
    pub config_path: String,
}

/// What each executable answered to `--version`, so it is asked once.
static VERSIONS: Mutex<Option<std::collections::HashMap<PathBuf, String>>> = Mutex::new(None);

/// Where each CLI in the table was found, if it was.
fn found() -> Vec<(&'static Cli, PathBuf)> {
    CLIS.iter().filter_map(|c| platform::find_exe(c.stem).map(|exe| (c, exe))).collect()
}

/// Writes the config file for every CLI on this machine, and brings the
/// detected half of each up to date. See agents.rs for what is in them.
///
/// Called when the island asks what is installed, which is the moment Coucou
/// knows where each one is.
pub fn map_configs() {
    for (spec, exe) in found() {
        agents::ensure(spec.id, spec.label, &exe, spec.prompt_args, spec.streams);
    }
}

/// Which agent CLIs are on this machine, with whatever versions are known.
///
/// Instant on purpose. The lookup itself is cheap and is done on every call —
/// installing a CLI should not need a restart to show up — but a version costs
/// a process start, and an npm shim starting cold takes seconds. So the
/// versions are only read from the cache here and filled in by `versions()`.
pub fn installed() -> Vec<Console> {
    let known = VERSIONS.lock().unwrap();
    found()
        .into_iter()
        .map(|(spec, exe)| Console {
            id: spec.id,
            label: spec.label,
            path: display_path(&exe),
            version: known
                .as_ref()
                .and_then(|seen| seen.get(&exe))
                .cloned()
                .unwrap_or_default(),
            color: spec.color,
            can: Capabilities {
                streaming: spec.streams,
                // One flag in the table, because the session id that makes a
                // reply streamable is the same one that makes it resumable.
                resume: spec.streams,
                approvable: spec.approvable,
            },
            verified: spec.verified,
            config_path: display_path(&agents::path_for(spec.id)),
        })
        .collect()
}

/// Asks every installed CLI its version and hands back the finished list, or
/// `None` when it says nothing `installed()` did not already know.
///
/// All of them at once: in series, seven CLIs would be seven cold starts.
pub async fn versions() -> Option<Vec<Console>> {
    let before = installed();
    let asking: Vec<_> = found()
        .into_iter()
        .map(|(_, exe)| tokio::spawn(async move { version_of(&exe).await }))
        .collect();
    for asked in asking {
        let _ = asked.await;
    }

    let after = installed();
    let changed = before.len() != after.len()
        || before.iter().zip(&after).any(|(a, b)| a.version != b.version);
    changed.then_some(after)
}

/// What `exe --version` says, trimmed to one line. Empty when it says nothing,
/// takes too long, or is not the kind of program that answers that flag.
async fn version_of(exe: &Path) -> String {
    if let Some(known) = VERSIONS.lock().unwrap().as_ref().and_then(|seen| seen.get(exe)).cloned() {
        return known;
    }

    let mut cmd = Command::new(exe);
    cmd.arg("--version");
    cmd.stdin(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    let answer = match tokio::time::timeout(VERSION_TIMEOUT, cmd.output()).await {
        Ok(Ok(out)) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            first_chars(text.lines().next().unwrap_or("").trim(), 40)
        }
        _ => String::new(),
    };

    VERSIONS
        .lock()
        .unwrap()
        .get_or_insert_with(std::collections::HashMap::new)
        .insert(exe.to_path_buf(), answer.clone());
    answer
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_three_capabilities_are_claimed_separately() {
        for spec in CLIS {
            // Streaming and approvable are different claims. A CLI that gains
            // a streaming JSON format does not thereby gain hooks Coucou
            // installs, and the island must not imply it did.
            if spec.approvable {
                assert_eq!(spec.id, "claude", "{} claims the island can approve it", spec.id);
            }
            // Nothing claims to be verified that was never run from here.
            if spec.verified {
                assert!(
                    ["claude", "gemini", "copilot"].contains(&spec.id),
                    "{} claims to have been run from Coucou",
                    spec.id
                );
            }
            assert!(spec.color.starts_with('#'), "{} needs a mascot colour", spec.id);
            assert_eq!(spec.color.len(), 7, "{}: a six-digit hex colour", spec.id);
        }
    }

    #[test]
    fn every_cli_in_the_table_is_usable() {
        let mut seen: Vec<&str> = Vec::new();
        for spec in CLIS {
            assert!(!seen.contains(&spec.id), "{} is listed twice", spec.id);
            seen.push(spec.id);
            assert!(!spec.stem.is_empty(), "{} has nothing to look for", spec.id);
            assert!(
                !spec.prompt_args.is_empty(),
                "{} would be run with the prompt as its first argument",
                spec.id
            );
            // Streaming means the flags only Claude Code takes, so anything
            // else claiming it would be run with arguments it does not know.
            assert_eq!(spec.streams, spec.id == "claude", "{} claims to stream", spec.id);
        }
        assert!(spec("claude").is_some(), "the one whose hooks we install must be there");
        assert!(spec("ollama").is_none(), "a model runner is not an agent CLI");
    }

}
