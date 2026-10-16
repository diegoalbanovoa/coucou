//! Memory for the provider chat (plan v4, Fase 5): notes the user pinned and a
//! cached summary of the part of a long conversation that no longer fits.
//!
//! Stored under `local_dir()/memory/` — data, not preferences. Never a key: the
//! only things written here are the user's own notes and a summary the model
//! wrote. Retrieval is plain keyword scoring (TF-IDF), no crate and no
//! embeddings (those are decision D5b, out of v4).
//!
//! Callers: the provider chat in `providers` / `lib` (retrieval and summary
//! cache) and the Settings commands that list, add and delete notes. Every
//! write goes through a temp file + rename (or a single append), so a crash
//! never leaves a half-written list. The `*_in(dir, ..)` variants take the
//! directory explicitly so tests can run in a scratch folder.

use std::collections::{hash_map::DefaultHasher, HashMap};
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::platform;

/// Maximum number of notes kept; past it the oldest are dropped.
pub const MAX_NOTES: usize = 500;
/// Maximum characters per note; longer text is truncated, not refused.
pub const MAX_NOTE_CHARS: usize = 2000;
/// How many notes, and how many characters of them, go along with one turn.
pub const RETRIEVE_K: usize = 3;
/// Character budget for all the notes retrieved for one turn (see [`RETRIEVE_K`]).
pub const RETRIEVE_MAX_CHARS: usize = 2000;

/// One pinned note, a line of `notes.jsonl`. Serialized with camelCase keys
/// because it also crosses to the frontend.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    /// Unique id (UUID v4), used to delete the note.
    pub id: String,
    /// Creation time, milliseconds since the Unix epoch.
    pub at: u64,
    /// The note body, trimmed and capped at [`MAX_NOTE_CHARS`].
    pub text: String,
}

/// The cached summary of the earlier conversation. Only a cache: if the hash of
/// what it covers no longer matches, it is regenerated.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Summary {
    /// Number of leading messages the summary stands for.
    pub covered: usize,
    /// Hash of those messages (see [`hash_covered`]); the cache key.
    pub covered_hash: u64,
    /// The summary text the model wrote.
    pub text: String,
}

/// Directory holding the memory files (`<local_dir>/memory`).
pub fn dir() -> PathBuf {
    platform::local_dir().join("memory")
}

/// Path of the JSON-lines file with the notes, one [`Note`] per line.
fn notes_file(dir: &Path) -> PathBuf {
    dir.join("notes.jsonl")
}

/// Path of the single-object JSON file with the cached [`Summary`].
fn summary_file(dir: &Path) -> PathBuf {
    dir.join("summary.json")
}

/// Trims and truncates note text to [`MAX_NOTE_CHARS`] characters (not bytes).
fn cap_text(text: &str) -> String {
    text.trim().chars().take(MAX_NOTE_CHARS).collect()
}

// ── Notes ─────────────────────────────────────────────────────────────────

/// Reads every note, skipping a UTF-8 BOM and any line that does not parse
/// (a corrupt line loses only itself). A missing file is an empty list.
fn read_notes(dir: &Path) -> Vec<Note> {
    let Ok(text) = std::fs::read_to_string(notes_file(dir)) else { return Vec::new() };
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

/// Rewrites the whole file through a temporary and a rename, so a crash in the
/// middle never leaves half a list.
fn write_notes(dir: &Path, notes: &[Note]) -> std::io::Result<()> {
    platform::ensure_private_dir(dir)?;
    let mut bytes = Vec::new();
    for n in notes {
        if let Ok(line) = serde_json::to_string(n) {
            bytes.extend_from_slice(line.as_bytes());
            bytes.push(b'\n');
        }
    }
    let file = notes_file(dir);
    let temp = file.with_extension("jsonl.writing");
    std::fs::write(&temp, &bytes)?;
    std::fs::rename(&temp, &file)
}

/// Appends a note and returns it. Errors with `InvalidInput` if the text is
/// empty after trimming. At the cap it rewrites the file without the oldest
/// notes; below it, a single append avoids rewriting the whole file.
fn add_note_in(dir: &Path, text: &str, at: u64, id: String) -> std::io::Result<Note> {
    // Redact before capping and before touching disk: notes are also sent to
    // the provider later (`memory_context`), so a pinned key must not survive.
    let redacted = crate::redact::redact(text);
    if redacted.count > 0 {
        crate::log::line(format!("memory: {} secretos ocultados al guardar una nota", redacted.count));
    }
    let note = Note { id, at, text: cap_text(&redacted.text) };
    if note.text.is_empty() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "empty note"));
    }
    let existing = read_notes(dir);
    if existing.len() >= MAX_NOTES {
        // Over the cap the oldest goes: rewrite without it, then the new one.
        let mut kept = existing;
        kept.push(note.clone());
        let excess = kept.len() - MAX_NOTES;
        kept.drain(..excess);
        write_notes(dir, &kept)?;
        return Ok(note);
    }
    platform::ensure_private_dir(dir)?;
    let line = serde_json::to_string(&note).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(notes_file(dir))?;
    // One write, newline included, as quick_assistant::log_action does.
    file.write_all(format!("{line}\n").as_bytes())?;
    Ok(note)
}

/// Saves a new note stamped with the current time and a fresh id. The error
/// is a display string (empty text or an I/O failure), ready for the UI.
pub fn add_note(text: &str) -> Result<Note, String> {
    add_note_in(&dir(), text, crate::usage::now_ms(), crate::agent::uuid_v4()).map_err(|e| e.to_string())
}

/// All notes, oldest first.
pub fn list_notes() -> Vec<Note> {
    read_notes(&dir())
}

/// Rewrites the file without the note `id`; an unknown id is not an error.
fn delete_note_in(dir: &Path, id: &str) -> std::io::Result<()> {
    let notes: Vec<Note> = read_notes(dir).into_iter().filter(|n| n.id != id).collect();
    write_notes(dir, &notes)
}

/// Deletes one note by id (no-op if absent).
pub fn delete_note(id: &str) -> Result<(), String> {
    delete_note_in(&dir(), id).map_err(|e| e.to_string())
}

/// Deletes every note (Settings "clear memory").
pub fn clear_notes() -> Result<(), String> {
    write_notes(&dir(), &[]).map_err(|e| e.to_string())
}

// ── Retrieval ──────────────────────────────────────────────────────────────

/// Lowercase and strip the diacritics of Spanish and the usual Latin accents.
/// A replacement table rather than a crate (same idea as search.ts).
pub fn normalize(s: &str) -> String {
    s.chars()
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            'á' | 'à' | 'ä' | 'â' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            'ç' => 'c',
            other => other,
        })
        .collect()
}

/// Words too common to say anything, English and Spanish, already normalized.
const STOPWORDS: &[&str] = &[
    "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "was", "has", "had", "how", "what", "who",
    "with", "this", "that", "from", "your", "have", "does", "del", "los", "las", "una", "uno", "por", "con", "para",
    "que", "como", "cual", "cuales", "mas", "pero", "sus", "este", "esta", "esto", "ese", "esa", "son", "fue",
    "mis", "tus", "mio", "mia", "hay", "muy", "sin", "sobre", "entre",
];

/// Splits text into normalized alphanumeric words of 3+ characters, dropping
/// stopwords. Used for both the query and the notes so they compare fairly.
pub fn tokens(s: &str) -> Vec<String> {
    normalize(s)
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.chars().count() >= 3 && !STOPWORDS.contains(t))
        .map(str::to_string)
        .collect()
}

/// The notes that best match `query`, best first, at most `k` of them and at
/// most `max_chars` characters in all. Score is TF-IDF with `idf = ln(1 +
/// N/df)`; a note that scores 0 is never returned.
pub fn retrieve(notes: &[Note], query: &str, k: usize, max_chars: usize) -> Vec<Note> {
    let query_tokens = tokens(query);
    if notes.is_empty() || query_tokens.is_empty() {
        return Vec::new();
    }
    let docs: Vec<Vec<String>> = notes.iter().map(|n| tokens(&n.text)).collect();
    let n = notes.len() as f64;
    let mut idf: HashMap<&str, f64> = HashMap::new();
    for q in &query_tokens {
        let df = docs.iter().filter(|d| d.contains(q)).count() as f64;
        if df > 0.0 {
            idf.insert(q.as_str(), (1.0 + n / df).ln());
        }
    }
    let mut scored: Vec<(f64, usize)> = docs
        .iter()
        .enumerate()
        .map(|(i, doc)| {
            let len = doc.len().max(1) as f64;
            let score: f64 = query_tokens
                .iter()
                .map(|q| {
                    let tf = doc.iter().filter(|t| *t == q).count() as f64 / len;
                    tf * idf.get(q.as_str()).copied().unwrap_or(0.0)
                })
                .sum();
            (score, i)
        })
        .filter(|(s, _)| *s > 0.0)
        .collect();
    // Best first; a tie keeps the newer note.
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then(b.1.cmp(&a.1)));
    let mut out = Vec::new();
    let mut used = 0usize;
    for (_, i) in scored.into_iter().take(k) {
        let len = notes[i].text.chars().count();
        if used + len > max_chars {
            break;
        }
        used += len;
        out.push(notes[i].clone());
    }
    out
}

// ── Summary cache ──────────────────────────────────────────────────────────

/// A hash of the `role` + `content` the summary covers. Only a cache key, not
/// anything that needs to be stable across Rust versions.
pub fn hash_covered(messages: &[(String, String)]) -> u64 {
    let mut h = DefaultHasher::new();
    for (role, content) in messages {
        role.hash(&mut h);
        content.hash(&mut h);
    }
    h.finish()
}

/// Reads the cached summary, tolerating a UTF-8 BOM. A missing or corrupt
/// file yields `None` (the summary is then simply regenerated).
fn read_summary_in(dir: &Path) -> Option<Summary> {
    let bytes = std::fs::read(summary_file(dir)).ok()?;
    let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    serde_json::from_slice(text).ok()
}

/// Replaces the cached summary atomically (temp file + rename).
fn write_summary_in(dir: &Path, summary: &Summary) -> std::io::Result<()> {
    platform::ensure_private_dir(dir)?;
    let bytes = serde_json::to_vec(summary).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let file = summary_file(dir);
    let temp = file.with_extension("json.writing");
    std::fs::write(&temp, bytes)?;
    std::fs::rename(&temp, &file)
}

/// The cached summary, but only if it covers exactly `messages`.
pub fn cached_summary_in(dir: &Path, messages: &[(String, String)]) -> Option<String> {
    let s = read_summary_in(dir)?;
    (s.covered == messages.len() && s.covered_hash == hash_covered(messages)).then_some(s.text)
}

/// [`cached_summary_in`] against the real memory directory.
pub fn cached_summary(messages: &[(String, String)]) -> Option<String> {
    cached_summary_in(&dir(), messages)
}

/// Caches `text` as the summary of exactly `messages` (`(role, content)`
/// pairs). Best effort: a write failure only means it is regenerated later.
pub fn store_summary(messages: &[(String, String)], text: &str) {
    let _ = store_summary_in(&dir(), messages, text);
}

/// [`store_summary`] against `dir`. The text is redacted first: the summary
/// is re-sent to the provider on later turns and must not carry a key.
fn store_summary_in(dir: &Path, messages: &[(String, String)], text: &str) -> std::io::Result<()> {
    let s = Summary { covered: messages.len(), covered_hash: hash_covered(messages), text: crate::redact::redact(text).text };
    write_summary_in(dir, &s)
}

/// "Nuevo chat" forgets the summary; the notes stay (they go from Settings).
pub fn forget_summary() {
    let _ = std::fs::remove_file(summary_file(&dir()));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("coucou-memory-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn note(id: &str, text: &str) -> Note {
        Note { id: id.into(), at: 0, text: text.into() }
    }

    #[test]
    fn a_note_with_a_key_is_redacted_before_it_reaches_disk() {
        let d = scratch("redact-note");
        let key = format!("sk-{}", "a1B2c3D4e5F6g7H8i9J0k1L2");
        let n = add_note_in(&d, &format!("OPENAI_API_KEY={key} para el proyecto"), 1, "a".into()).unwrap();
        assert!(n.text.contains("[REDACTED:"));
        let on_disk = std::fs::read_to_string(notes_file(&d)).unwrap();
        assert!(on_disk.contains("[REDACTED:"));
        assert!(!on_disk.contains(&key));
    }

    #[test]
    fn a_summary_with_a_key_is_redacted_before_it_reaches_disk() {
        let d = scratch("redact-summary");
        let key = format!("sk-{}", "a1B2c3D4e5F6g7H8i9J0k1L2");
        let msgs = vec![("user".to_string(), "hola".to_string())];
        store_summary_in(&d, &msgs, &format!("El usuario usa OPENAI_API_KEY={key}")).unwrap();
        let on_disk = std::fs::read_to_string(summary_file(&d)).unwrap();
        assert!(on_disk.contains("[REDACTED:"));
        assert!(!on_disk.contains(&key));
        assert!(cached_summary_in(&d, &msgs).unwrap().contains("[REDACTED:"));
    }

    #[test]
    fn notes_are_capped_and_the_oldest_goes() {
        let d = scratch("cap");
        for i in 0..MAX_NOTES + 3 {
            add_note_in(&d, &format!("note {i}"), i as u64, format!("id{i}")).unwrap();
        }
        let notes = read_notes(&d);
        assert_eq!(notes.len(), MAX_NOTES);
        assert_eq!(notes[0].id, "id3");
        assert_eq!(notes.last().unwrap().id, format!("id{}", MAX_NOTES + 2));
    }

    #[test]
    fn a_note_is_trimmed_to_2000_chars_and_an_empty_one_refused() {
        let d = scratch("trim");
        let n = add_note_in(&d, &"x".repeat(3000), 1, "a".into()).unwrap();
        assert_eq!(n.text.chars().count(), MAX_NOTE_CHARS);
        assert!(add_note_in(&d, "   ", 1, "b".into()).is_err());
    }

    #[test]
    fn delete_and_clear_rewrite_the_file() {
        let d = scratch("del");
        add_note_in(&d, "one", 1, "a".into()).unwrap();
        add_note_in(&d, "two", 2, "b".into()).unwrap();
        delete_note_in(&d, "a").unwrap();
        assert_eq!(read_notes(&d).iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), ["b"]);
        write_notes(&d, &[]).unwrap();
        assert!(read_notes(&d).is_empty());
    }

    #[test]
    fn retrieve_ignores_accents_and_case() {
        let notes = [note("a", "Mi perro se llama Toby"), note("b", "La contraseña del wifi es larga")];
        let got = retrieve(&notes, "¿Cómo se LLAMA mi PERRO?", 3, 2000);
        assert_eq!(got.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), ["a"]);
        let got = retrieve(&notes, "contrasena", 3, 2000);
        assert_eq!(got[0].id, "b");
    }

    #[test]
    fn stopwords_and_short_words_do_not_match() {
        let notes = [note("a", "the cat and the hat")];
        assert!(retrieve(&notes, "the and for", 3, 2000).is_empty());
        assert!(retrieve(&notes, "ab xy", 3, 2000).is_empty());
    }

    #[test]
    fn no_match_gives_nothing() {
        let notes = [note("a", "toby is a dog")];
        assert!(retrieve(&notes, "bicycle", 3, 2000).is_empty());
        assert!(retrieve(&[], "toby", 3, 2000).is_empty());
    }

    #[test]
    fn retrieve_respects_k_and_the_character_cap() {
        let notes = [note("a", "toby one"), note("b", "toby two"), note("c", "toby three")];
        assert_eq!(retrieve(&notes, "toby", 2, 2000).len(), 2);
        // Ties keep the newer first: 10 + 8 fit in 18, the third (8) does not.
        assert_eq!(retrieve(&notes, "toby", 3, 18).len(), 2);
    }

    #[test]
    fn a_rarer_word_scores_higher() {
        let notes = [note("a", "dog food"), note("b", "dog walk"), note("c", "zebra dog")];
        let got = retrieve(&notes, "zebra", 3, 2000);
        assert_eq!(got[0].id, "c");
    }

    #[test]
    fn the_summary_round_trips_and_a_changed_hash_invalidates_it() {
        let d = scratch("summary");
        let msgs = vec![("user".to_string(), "hola".to_string()), ("assistant".to_string(), "qué tal".to_string())];
        assert_eq!(cached_summary_in(&d, &msgs), None);
        let s = Summary { covered: msgs.len(), covered_hash: hash_covered(&msgs), text: "resumen".into() };
        write_summary_in(&d, &s).unwrap();
        assert_eq!(cached_summary_in(&d, &msgs), Some("resumen".to_string()));
        let other = vec![("user".to_string(), "distinto".to_string()), msgs[1].clone()];
        assert_eq!(cached_summary_in(&d, &other), None);
        assert_eq!(cached_summary_in(&d, &msgs[..1]), None);
    }

    #[test]
    fn nothing_here_looks_like_a_key() {
        // The module has no path to secrets.rs: a guard on the file's own text.
        let source = include_str!("memory.rs");
        let forbidden = ["secrets", "::", "get("].concat();
        assert!(!source.contains(&forbidden));
    }
}
