//! Importable skills in the open agentskills.io format (plan v4, Fase 6): a
//! folder with a `SKILL.md` -- YAML frontmatter with a `name` and a
//! `description`, then Markdown.
//!
//! A skill here is INSTRUCTIONS and nothing else. Hard rules:
//!   * only `SKILL.md` is ever copied -- `scripts/`, `references/` and `assets/`
//!     are not, and nothing from `scripts/` is ever run;
//!   * `allowed-tools` is read and ignored: it approves nothing in advance;
//!   * the model can only get a skill's text through the `load_skill` tool,
//!     which `quick_assistant::dispatch` gates like every other tool.
//!
//! The frontmatter parser is written by hand (no crate). It understands what a
//! SKILL.md needs: top-level `key: value` scalars, quoted or not, plus `>` / `|`
//! block scalars; anything indented under another key (`metadata:`) is skipped.
//! Skills live under the config dir; the settings window imports and lists them
//! and routines / the quick assistant load them.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::platform;

/// `SKILL.md` files larger than this are refused.
pub const MAX_SKILL_BYTES: u64 = 256 * 1024;
/// What `load_skill` hands back at most.
pub const MAX_LOADED_BYTES: usize = 64 * 1024;

/// An installed skill as the model receives it: name, one-line description and
/// the Markdown body (the frontmatter is stripped).
#[derive(Clone, Debug, PartialEq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub body: String,
}

/// What the settings window sees of an installed skill.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillView {
    pub name: String,
    pub description: String,
    pub enabled: bool,
    /// What the source had that Coucou does not take: `scripts`, `references`,
    /// `assets` and `allowed-tools`.
    pub ignored: Vec<String>,
}

/// The parsed frontmatter of a SKILL.md, already validated.
#[derive(Debug, PartialEq)]
pub struct Frontmatter {
    pub name: String,
    pub description: String,
    /// The top-level keys that were there, for `allowed-tools`.
    pub keys: Vec<String>,
}

/// Folder holding one subfolder per installed skill, each with its `SKILL.md`.
pub fn skills_dir() -> PathBuf {
    platform::config_dir().join("skills")
}

/// The agentskills.io rule for a skill name: 1 to 64 characters of `[a-z0-9-]`,
/// no leading or trailing hyphen, no `--`.
pub fn valid_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--")
}

/// Trims a scalar and removes one pair of matching single or double quotes.
fn unquote(value: &str) -> String {
    let v = value.trim();
    for q in ['"', '\''] {
        if v.len() >= 2 && v.starts_with(q) && v.ends_with(q) {
            return v[1..v.len() - 1].to_string();
        }
    }
    v.to_string()
}

/// Splits a SKILL.md into validated frontmatter and trimmed body.
/// Errors (user-facing text) if the `---` fences are missing or unclosed, or if
/// `name` / `description` are absent or invalid (name per [`valid_name`],
/// description 1 to 1024 characters).
pub fn parse_skill_md(text: &str) -> Result<(Frontmatter, String), String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return Err("SKILL.md must start with a --- frontmatter line".to_string());
    }
    let mut front: Vec<&str> = Vec::new();
    let mut closed = false;
    let mut body_lines: Vec<&str> = Vec::new();
    for line in lines.by_ref() {
        if line.trim_end() == "---" {
            closed = true;
            break;
        }
        front.push(line);
    }
    if !closed {
        return Err("the frontmatter is never closed with a --- line".to_string());
    }
    body_lines.extend(lines);
    let body = body_lines.join("\n").trim().to_string();

    let mut name = None;
    let mut description = None;
    let mut keys = Vec::new();
    let mut i = 0;
    while i < front.len() {
        let line = front[i];
        i += 1;
        // Indented lines belong to the key above (`metadata:` and friends).
        if line.trim().is_empty() || line.starts_with(' ') || line.starts_with('\t') || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        let key = key.trim().to_string();
        let value = value.trim();
        keys.push(key.clone());
        // A block scalar's text is the indented lines that follow.
        let folded = matches!(value.chars().next(), Some('>') | Some('|')) && value.len() <= 2;
        let value = if folded {
            let literal = value.starts_with('|');
            let mut parts: Vec<&str> = Vec::new();
            while i < front.len() && (front[i].starts_with(' ') || front[i].starts_with('\t') || front[i].trim().is_empty()) {
                parts.push(front[i].trim());
                i += 1;
            }
            let joined = parts.join(if literal { "\n" } else { " " });
            joined.trim().to_string()
        } else {
            unquote(value)
        };
        match key.as_str() {
            "name" => name = Some(value),
            "description" => description = Some(value),
            _ => {}
        }
    }
    let name = name.ok_or_else(|| "the frontmatter has no name".to_string())?;
    if !valid_name(&name) {
        return Err(format!("the name {name:?} is not valid (1-64 of a-z, 0-9 and -, no leading, trailing or double hyphen)"));
    }
    let description = description.ok_or_else(|| "the frontmatter has no description".to_string())?;
    let len = description.chars().count();
    if !(1..=1024).contains(&len) {
        return Err("the description must be 1 to 1024 characters".to_string());
    }
    Ok((Frontmatter { name, description, keys }, body))
}

/// Reads a SKILL.md as UTF-8, refusing non-files and files over `MAX_SKILL_BYTES`.
fn read_skill_md(file: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(file).map_err(|_| "there is no SKILL.md in that folder".to_string())?;
    if !meta.is_file() {
        return Err("there is no SKILL.md in that folder".to_string());
    }
    if meta.len() > MAX_SKILL_BYTES {
        return Err("SKILL.md is larger than 256 KiB".to_string());
    }
    let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "SKILL.md is not valid UTF-8".to_string())
}

/// What the source folder has that is not imported.
fn ignored_in(src_dir: &Path, front: &Frontmatter) -> Vec<String> {
    let mut ignored = Vec::new();
    for d in ["scripts", "references", "assets"] {
        if src_dir.join(d).exists() {
            ignored.push(d.to_string());
        }
    }
    if front.keys.iter().any(|k| k == "allowed-tools") {
        ignored.push("allowed-tools".to_string());
    }
    ignored
}

/// Copies `src_dir/SKILL.md` — and only that — to `root/<name>/SKILL.md`,
/// through a temporary and a rename. `root` is `skills_dir()` outside tests.
pub fn import_to(root: &Path, src_dir: &Path, replace: bool) -> Result<SkillView, String> {
    let text = read_skill_md(&src_dir.join("SKILL.md"))?;
    let (front, _) = parse_skill_md(&text)?;
    let folder = src_dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if folder != front.name {
        return Err(format!("the name {:?} does not match the folder name {folder:?}", front.name));
    }
    let target_dir = root.join(&front.name);
    if target_dir.exists() && !replace {
        return Err(format!("exists:{}", front.name));
    }
    platform::ensure_private_dir(&target_dir).map_err(|e| e.to_string())?;
    let target = target_dir.join("SKILL.md");
    let temp = target_dir.join("SKILL.md.writing");
    std::fs::write(&temp, text.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &target).map_err(|e| e.to_string())?;
    Ok(SkillView {
        ignored: ignored_in(src_dir, &front),
        name: front.name,
        description: front.description,
        enabled: false,
    })
}

/// Imports a skill from `src_dir` into the user's skills folder; see [`import_to`].
/// `replace` allows overwriting an installed skill of the same name.
pub fn import(src_dir: &Path, replace: bool) -> Result<SkillView, String> {
    import_to(&skills_dir(), src_dir, replace)
}

/// Installed skills under `root`, sorted by name. Entries whose folder name does
/// not match their frontmatter name, or that fail to parse, are skipped.
fn list_in(root: &Path, enabled: &[String]) -> Vec<SkillView> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut out: Vec<SkillView> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let text = read_skill_md(&e.path().join("SKILL.md")).ok()?;
            let (front, _) = parse_skill_md(&text).ok()?;
            (front.name == name).then(|| SkillView {
                enabled: enabled.contains(&name),
                name,
                description: front.description,
                // Only SKILL.md is ever stored, so what was left out is not
                // known here; the import result reported it once.
                ignored: Vec::new(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Installed skills, flagged `enabled` when their name is in `enabled`.
pub fn list(enabled: &[String]) -> Vec<SkillView> {
    list_in(&skills_dir(), enabled)
}

/// Removes an installed skill. A skill that is already gone is not an error; the
/// name is validated first so it cannot escape the skills folder.
pub fn delete(name: &str) -> Result<(), String> {
    if !valid_name(name) {
        return Err("not a skill name".to_string());
    }
    match std::fs::remove_dir_all(skills_dir().join(name)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Loads one skill by name from `root`; `None` if invalid, missing or mismatched.
fn load_in(root: &Path, name: &str) -> Option<Skill> {
    if !valid_name(name) {
        return None;
    }
    let text = read_skill_md(&root.join(name).join("SKILL.md")).ok()?;
    let (front, body) = parse_skill_md(&text).ok()?;
    (front.name == name).then_some(Skill { name: front.name, description: front.description, body })
}

/// Loads an installed skill by name, whether or not the user has it enabled
/// (callers must check `skills_enabled` themselves).
pub fn load(name: &str) -> Option<Skill> {
    load_in(&skills_dir(), name)
}

/// `body` cut to `MAX_LOADED_BYTES` on a character boundary.
pub fn truncate_body(body: &str) -> String {
    if body.len() <= MAX_LOADED_BYTES {
        return body.to_string();
    }
    let mut end = MAX_LOADED_BYTES;
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    body[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = "---\nname: pdf-tools\ndescription: \"Work with PDFs\"\nallowed-tools: Bash(rm:*)\nmetadata:\n  author: me\n  version: \"1\"\n---\n# Body\n\nDo things.\n";

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("coucou-skills-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A source skill folder named `name` holding `text`.
    fn source(root: &Path, name: &str, text: &str) -> PathBuf {
        let d = root.join(name);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("SKILL.md"), text).unwrap();
        d
    }

    #[test]
    fn a_valid_frontmatter_is_read() {
        let (f, body) = parse_skill_md(GOOD).unwrap();
        assert_eq!(f.name, "pdf-tools");
        assert_eq!(f.description, "Work with PDFs");
        assert!(f.keys.contains(&"allowed-tools".to_string()));
        assert!(!f.keys.contains(&"author".to_string()));
        assert_eq!(body, "# Body\n\nDo things.");
    }

    #[test]
    fn single_quotes_and_block_scalars_work() {
        let text = "---\nname: a\ndescription: >\n  first line\n  second line\n---\nx";
        assert_eq!(parse_skill_md(text).unwrap().0.description, "first line second line");
        let text = "---\nname: 'a'\ndescription: 'ok'\n---\nx";
        assert_eq!(parse_skill_md(text).unwrap().0.name, "a");
    }

    #[test]
    fn a_bom_is_stripped() {
        assert!(parse_skill_md(&format!("\u{feff}{GOOD}")).is_ok());
    }

    #[test]
    fn invalid_names_are_refused() {
        for bad in ["PDF-Tools", "-pdf", "pdf-", "pdf--tools", "pdf_tools", "", &"a".repeat(65)] {
            let text = format!("---\nname: {bad}\ndescription: d\n---\nx");
            assert!(parse_skill_md(&text).is_err(), "{bad:?} should be refused");
        }
        assert!(valid_name("a") && valid_name("pdf-tools-2") && valid_name(&"a".repeat(64)));
    }

    #[test]
    fn the_description_must_exist_and_fit() {
        assert!(parse_skill_md("---\nname: a\ndescription:\n---\nx").is_err());
        assert!(parse_skill_md("---\nname: a\n---\nx").is_err());
        let long = format!("---\nname: a\ndescription: {}\n---\nx", "d".repeat(1025));
        assert!(parse_skill_md(&long).is_err());
        let max = format!("---\nname: a\ndescription: {}\n---\nx", "d".repeat(1024));
        assert!(parse_skill_md(&max).is_ok());
    }

    #[test]
    fn no_frontmatter_is_an_error() {
        assert!(parse_skill_md("# just markdown").is_err());
        assert!(parse_skill_md("---\nname: a\ndescription: d\nno end").is_err());
    }

    #[test]
    fn import_copies_only_skill_md_never_scripts() {
        let tmp = scratch("import");
        let src = source(&tmp.join("src"), "pdf-tools", GOOD);
        std::fs::create_dir_all(src.join("scripts")).unwrap();
        std::fs::write(src.join("scripts").join("run.sh"), "rm -rf /").unwrap();
        std::fs::create_dir_all(src.join("references")).unwrap();
        std::fs::write(src.join("references").join("a.md"), "x").unwrap();
        let root = tmp.join("skills");
        let view = import_to(&root, &src, false).unwrap();
        assert_eq!(view.name, "pdf-tools");
        assert!(!view.enabled);
        assert_eq!(view.ignored, ["scripts", "references", "allowed-tools"]);
        let copied: Vec<String> = std::fs::read_dir(root.join("pdf-tools"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(copied, ["SKILL.md"]);
    }

    #[test]
    fn the_name_must_match_the_folder() {
        let tmp = scratch("mismatch");
        let src = source(&tmp.join("src"), "other-name", GOOD);
        assert!(import_to(&tmp.join("skills"), &src, false).unwrap_err().contains("does not match"));
    }

    #[test]
    fn an_existing_skill_needs_replace() {
        let tmp = scratch("exists");
        let src = source(&tmp.join("src"), "pdf-tools", GOOD);
        let root = tmp.join("skills");
        import_to(&root, &src, false).unwrap();
        assert_eq!(import_to(&root, &src, false).unwrap_err(), "exists:pdf-tools");
        assert!(import_to(&root, &src, true).is_ok());
    }

    #[test]
    fn a_missing_or_huge_skill_md_is_refused() {
        let tmp = scratch("size");
        let empty = tmp.join("src").join("a");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(import_to(&tmp.join("skills"), &empty, false).is_err());
        let big = format!("---\nname: big\ndescription: d\n---\n{}", "x".repeat(300 * 1024));
        let src = source(&tmp.join("src"), "big", &big);
        assert!(import_to(&tmp.join("skills"), &src, false).unwrap_err().contains("256 KiB"));
    }

    #[test]
    fn list_and_load_read_what_was_imported() {
        let tmp = scratch("list");
        let src = source(&tmp.join("src"), "pdf-tools", GOOD);
        let root = tmp.join("skills");
        import_to(&root, &src, false).unwrap();
        let listed = list_in(&root, &["pdf-tools".to_string()]);
        assert_eq!(listed.len(), 1);
        assert!(listed[0].enabled);
        let skill = load_in(&root, "pdf-tools").unwrap();
        assert_eq!(skill.body, "# Body\n\nDo things.");
        assert!(load_in(&root, "../escape").is_none());
        assert!(load_in(&root, "missing").is_none());
    }

    #[test]
    fn a_long_body_is_cut_to_64_kib_on_a_char_boundary() {
        let body = "é".repeat(40_000);
        let cut = truncate_body(&body);
        assert!(cut.len() <= MAX_LOADED_BYTES);
        assert!(body.starts_with(&cut));
    }
}
