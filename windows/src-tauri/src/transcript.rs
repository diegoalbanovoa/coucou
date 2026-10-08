// The last stretch of the island's conversation, kept across restarts.
//
// Not in settings.json. This is text that grows, and one long reply would make
// a preference file unreadable; it also has nothing to do with preferences.
//
// The CLI session is resumed on the Rust side (see agent::Session), so without
// this the island would come back continuing a conversation it showed none of.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::platform;

/// How many messages are kept. Enough to pick a conversation back up, far
/// short of a transcript nobody reads.
const KEEP: usize = 40;
/// How much of one message is kept. A ten-thousand-line reply is not worth
/// carrying across a restart, and the island folds long replies down anyway.
const MAX_CHARS: usize = 20_000;

/// One message, in the shape the island already holds it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    /// "user", "assistant" or "error".
    pub role: String,
    pub content: String,
    /// Milliseconds since the epoch, as the webview counts them.
    pub at: f64,
    #[serde(default)]
    pub steps: Vec<String>,
}

fn path() -> PathBuf {
    platform::config_dir().join("chat.json")
}

/// The last messages, oldest first. Empty whenever there is nothing usable:
/// a missing file, or one written by something else.
pub fn load() -> Vec<Message> {
    match std::fs::read(path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Keeps `messages`, trimmed. Failure is logged and otherwise ignored: losing
/// the transcript costs a reread, and a chat turn must not fail over it.
pub fn save(messages: &[Message]) {
    let kept = trim(messages);
    let file = path();
    if let Err(err) = write(&file, &kept) {
        crate::log::line(format!("could not keep the conversation: {err}"));
    }
}

fn write(file: &std::path::Path, kept: &[Message]) -> std::io::Result<()> {
    platform::ensure_private_dir(&platform::config_dir())?;
    let bytes = serde_json::to_vec_pretty(kept)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    // Through a temporary file, so a crash mid-write leaves the last good
    // transcript rather than half of this one.
    let temp = file.with_extension("json.writing");
    std::fs::write(&temp, &bytes)?;
    std::fs::rename(&temp, file)
}

/// The last `KEEP` messages, each cut to `MAX_CHARS`.
pub fn trim(messages: &[Message]) -> Vec<Message> {
    let start = messages.len().saturating_sub(KEEP);
    messages[start..]
        .iter()
        .map(|message| Message {
            role: message.role.clone(),
            content: cut(&message.content, MAX_CHARS),
            at: message.at,
            steps: message.steps.clone(),
        })
        .collect()
}

/// Cut on a character boundary: slicing bytes panics mid-codepoint, and these
/// are full of box-drawing characters and emoji.
fn cut(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        None => text.to_string(),
        Some((i, _)) => format!("{}…", &text[..i]),
    }
}

/// Forgets the conversation. Used when the island starts a fresh one.
pub fn clear() {
    let _ = std::fs::remove_file(path());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: &str, content: &str) -> Message {
        Message { role: role.into(), content: content.into(), at: 1.0, steps: Vec::new() }
    }

    #[test]
    fn only_the_last_messages_are_kept() {
        let many: Vec<Message> =
            (0..KEEP + 10).map(|i| message("user", &format!("number {i}"))).collect();

        let kept = trim(&many);

        assert_eq!(kept.len(), KEEP);
        assert_eq!(kept.first().unwrap().content, "number 10", "the oldest ones go");
        assert_eq!(kept.last().unwrap().content, format!("number {}", KEEP + 9));
    }

    #[test]
    fn a_short_conversation_is_kept_whole() {
        let two = [message("user", "hi"), message("assistant", "hello")];
        assert_eq!(trim(&two), two);
    }

    #[test]
    fn a_runaway_reply_is_cut_on_a_character_boundary() {
        let long = message("assistant", &"★".repeat(MAX_CHARS + 50));

        let [kept] = trim(&[long]).try_into().unwrap();

        assert_eq!(kept.content.chars().count(), MAX_CHARS + 1, "the cut plus its ellipsis");
        assert!(kept.content.ends_with('…'));
    }

    #[test]
    fn a_file_that_is_not_ours_reads_as_no_conversation() {
        for bytes in [&b""[..], b"not json", b"{}", b"[{\"role\":1}]"] {
            assert!(
                serde_json::from_slice::<Vec<Message>>(bytes).unwrap_or_default().is_empty(),
                "{bytes:?} gave something"
            );
        }
    }

    #[test]
    fn steps_survive_a_round_trip_and_a_file_without_them_still_loads() {
        let with = Message {
            role: "assistant".into(),
            content: "done".into(),
            at: 17.5,
            steps: vec!["Read agent.rs".into()],
        };
        let json = serde_json::to_string(std::slice::from_ref(&with)).unwrap();
        assert_eq!(serde_json::from_str::<Vec<Message>>(&json).unwrap(), [with]);

        let older = r#"[{"role":"user","content":"hi","at":1}]"#;
        assert_eq!(serde_json::from_str::<Vec<Message>>(older).unwrap()[0].steps, Vec::<String>::new());
    }
}
