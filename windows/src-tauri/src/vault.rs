// The Obsidian vault, as a knowledge base the agent can read and write.
//
// The path used to be one line in agent.rs with `OneDrive\Documentos\Obsidian
// Vault` written into it. That is right for exactly one machine, and wrong
// silently: a vault moved or renamed just stopped reaching the agent.
//
// Obsidian keeps its own list of vaults in obsidian.json, so it is asked
// instead. What the user chose in the settings window wins over that, and
// "none" is the honest answer when neither has one — the settings window then
// offers the folder picker.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::platform;

/// Where the vault came from, so the settings window can say so.
#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    /// Chosen in the settings window.
    Chosen,
    /// Read out of Obsidian's own list.
    Obsidian,
    /// Nothing found, and nothing chosen.
    None,
}

/// The vault as the UI shows it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    /// Empty when there is none.
    pub path: String,
    pub source: Source,
    /// How many vaults Obsidian knows about, for the "or pick another" case.
    pub known: usize,
}

/// The vaults Obsidian knows about, the one it has open first and the rest
/// most recently used first.
///
/// Split from the file so the parsing can be tested: the shape of this file is
/// Obsidian's business and may well change under us.
pub fn vaults_in(json: &str) -> Vec<PathBuf> {
    let Ok(value) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    let Some(vaults) = value.get("vaults").and_then(Value::as_object) else {
        return Vec::new();
    };

    let mut rows: Vec<(bool, i64, PathBuf)> = vaults
        .values()
        .filter_map(|vault| {
            let path = vault.get("path").and_then(Value::as_str)?;
            let open = vault.get("open").and_then(Value::as_bool).unwrap_or(false);
            let used = vault.get("ts").and_then(Value::as_i64).unwrap_or(0);
            Some((open, used, PathBuf::from(path)))
        })
        .collect();

    // Open first, then most recently opened. `sort_by` keeps it stable, so two
    // vaults with the same timestamp stay in the order the file had them.
    rows.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    rows.into_iter().map(|(_, _, path)| path).collect()
}

/// Obsidian's vault list, read from disk. Empty when Obsidian is not installed
/// or has never been opened.
pub fn detected() -> Vec<PathBuf> {
    match std::fs::read_to_string(platform::obsidian_config()) {
        Ok(json) => vaults_in(&json).into_iter().filter(|p| p.is_dir()).collect(),
        Err(_) => Vec::new(),
    }
}

/// The vault to use: what was chosen, else what Obsidian has open.
///
/// A chosen path that is no longer a folder falls through to detection rather
/// than being handed to the agent as a directory that is not there.
pub fn resolve(chosen: Option<&str>) -> Option<PathBuf> {
    if let Some(path) = chosen.map(Path::new).filter(|p| p.is_dir()) {
        return Some(path.to_path_buf());
    }
    detected().into_iter().next()
}

/// What the settings window shows.
pub fn info(chosen: Option<&str>) -> VaultInfo {
    let known = detected();
    let picked = chosen.map(Path::new).filter(|p| p.is_dir());
    let source = match (&picked, known.first()) {
        (Some(_), _) => Source::Chosen,
        (None, Some(_)) => Source::Obsidian,
        (None, None) => Source::None,
    };
    let path = picked
        .map(Path::to_path_buf)
        .or_else(|| known.first().cloned())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    VaultInfo { path, source, known: known.len() }
}

/// What the agent is told about the vault, or nothing when there is no vault.
///
/// Only the path and the one convention that makes it usable. Claude Code gets
/// this as `--append-system-prompt`; the CLIs with no such flag get it in
/// front of the first message of a conversation.
pub fn briefing(vault: Option<&Path>) -> Option<String> {
    let vault = vault?;
    let index = vault.join("Sistema").join("Sistema.md");
    let mut text = format!(
        "The user's Obsidian vault is their knowledge base, at {}. \
         You can read and write inside it.",
        vault.display()
    );
    // Only mentioned when it is actually there: pointing at an index that does
    // not exist would send the agent looking for it.
    if index.is_file() {
        text.push_str(" Its documentation lives in Sistema/, indexed by Sistema/Sistema.md.");
    }
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL: &str = r#"{"vaults":{"2c4cca54ccc974e2":{"path":"C:\\Users\\diego\\OneDrive\\Documentos\\Obsidian Vault","ts":1785705328247,"open":true}},"language":"es","cli":true}"#;

    #[test]
    fn the_real_shape_of_obsidian_json_is_read() {
        assert_eq!(
            vaults_in(REAL),
            [PathBuf::from(r"C:\Users\diego\OneDrive\Documentos\Obsidian Vault")]
        );
    }

    #[test]
    fn the_open_vault_comes_first_then_the_most_recent() {
        let json = r#"{"vaults":{
            "a":{"path":"/old","ts":100},
            "b":{"path":"/open","ts":1,"open":true},
            "c":{"path":"/recent","ts":900}
        }}"#;
        assert_eq!(
            vaults_in(json),
            [PathBuf::from("/open"), PathBuf::from("/recent"), PathBuf::from("/old")]
        );
    }

    #[test]
    fn a_file_that_is_not_obsidians_yields_nothing() {
        for json in ["", "not json", "{}", r#"{"vaults":[]}"#, r#"{"vaults":{"a":{}}}"#] {
            assert!(vaults_in(json).is_empty(), "{json:?} gave something");
        }
    }

    #[test]
    fn a_chosen_folder_wins_and_one_that_is_gone_does_not() {
        let dir = std::env::temp_dir().join("coucou-vault-chosen");
        std::fs::create_dir_all(&dir).unwrap();

        let chosen = dir.to_string_lossy().to_string();
        assert_eq!(resolve(Some(&chosen)), Some(dir.clone()));
        assert_eq!(info(Some(&chosen)).source, Source::Chosen);

        // A path that is not a folder is not a vault, whatever settings say.
        let gone = dir.join("not-there").to_string_lossy().to_string();
        assert_ne!(resolve(Some(&gone)), Some(PathBuf::from(&gone)));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_briefing_names_the_vault_and_nothing_else_when_bare() {
        let dir = std::env::temp_dir().join("coucou-vault-briefing");
        std::fs::create_dir_all(&dir).unwrap();

        let text = briefing(Some(&dir)).unwrap();
        assert!(text.contains(&dir.display().to_string()), "got {text:?}");
        assert!(!text.contains("Sistema"), "an index that is not there: {text:?}");

        std::fs::create_dir_all(dir.join("Sistema")).unwrap();
        std::fs::write(dir.join("Sistema").join("Sistema.md"), "# index").unwrap();
        assert!(briefing(Some(&dir)).unwrap().contains("Sistema/Sistema.md"));

        assert_eq!(briefing(None), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
