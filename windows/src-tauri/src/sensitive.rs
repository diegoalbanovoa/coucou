// Files that usually hold secrets (.env, private keys, credential files). The
// quick assistant refuses to read them even inside an allow-listed folder, and
// hides them from folder listings and file searches. Judged by name, following
// symlinks, so an innocent-looking link to a `.env` is refused too.

use std::path::Path;

/// Message for the model when a read is refused.
pub const PROTECTED_ERR: &str = "that file is protected because it may hold secrets, so it was not read";

const EXACT: &[&str] = &[
    ".env",
    ".secret",
    "id_rsa",
    "id_ed25519",
    ".htpasswd",
    ".pgpass",
    ".netrc",
    "credentials",
    "id_ecdsa",
    "id_dsa",
];
const PREFIXES: &[&str] = &[".env.", "credentials."];
const SUFFIXES: &[&str] = &[".env", ".secrets", ".pem", ".key", ".p12", ".pfx", ".jks"];

/// True when the name (last component) matches the policy. ASCII
/// case-insensitive on every platform.
pub fn is_sensitive_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    EXACT.contains(&n.as_str())
        || PREFIXES.iter().any(|p| n.starts_with(p))
        || SUFFIXES.iter().any(|s| n.ends_with(s))
}

fn last_name(path: &Path) -> Option<String> {
    path.file_name().map(|n| n.to_string_lossy().to_string())
}

/// True when `path` is, or points to, a protected file. A folder is never
/// protected itself (a Python venv called `.env` can be listed); its entries
/// are judged one by one.
pub fn is_sensitive_path(path: &Path) -> bool {
    if std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false) {
        return false;
    }
    // NTFS alternate data streams (`.env::$DATA`): a colon in the last component.
    #[cfg(windows)]
    if last_name(path).map(|n| n.contains(':')).unwrap_or(false) {
        return true;
    }
    if last_name(path).map(|n| is_sensitive_name(&n)).unwrap_or(false) {
        return true;
    }
    // The chain of links: every link name and every target name counts.
    let mut candidate = path.to_path_buf();
    for _ in 0..40 {
        let Ok(target) = std::fs::read_link(&candidate) else { break };
        let next = if target.is_relative() {
            candidate.parent().map(|p| p.join(&target)).unwrap_or(target)
        } else {
            target
        };
        if last_name(&next).map(|n| is_sensitive_name(&n)).unwrap_or(false) {
            return true;
        }
        candidate = next;
    }
    // The fully resolved path (trailing-space names, 8.3 names, links in
    // intermediate folders).
    if let Ok(real) = path.canonicalize() {
        if last_name(&real).map(|n| is_sensitive_name(&n)).unwrap_or(false) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tempdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("coucou-sens-test-{}", crate::agent::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    fn link(src: &Path, dst: &Path) -> bool {
        std::os::unix::fs::symlink(src, dst).is_ok()
    }
    #[cfg(windows)]
    fn link(src: &Path, dst: &Path) -> bool {
        std::os::windows::fs::symlink_file(src, dst).is_ok()
    }

    #[test]
    fn every_listed_name_is_sensitive() {
        for n in [
            ".env", ".env.local", ".env.production", "prod.env", ".secret", "app.secrets", "credentials.json",
            "server.pem", "tls.key", "cert.p12", "cert.pfx", "keystore.jks", "id_rsa", "id_ed25519", ".htpasswd",
            ".pgpass", ".netrc", "credentials", "id_ecdsa", "id_dsa",
        ] {
            assert!(is_sensitive_name(n), "{n}");
        }
    }

    #[test]
    fn names_are_case_insensitive() {
        for n in [".ENV", "Server.PEM", "ID_RSA"] {
            assert!(is_sensitive_name(n), "{n}");
        }
    }

    #[test]
    fn ordinary_names_are_not_sensitive() {
        for n in [
            "README.md", "notes.txt", "environment.md", ".envrc", "env.txt", "id_rsa.pub", "keys.txt", "my.keychain",
            "secret.txt", "credentials_guide.md",
        ] {
            assert!(!is_sensitive_name(n), "{n}");
        }
    }

    #[test]
    fn an_innocent_link_to_a_secret_is_sensitive() {
        let dir = tempdir();
        let real = dir.join(".env");
        std::fs::write(&real, b"X=1").unwrap();
        let l = dir.join("notes.txt");
        if !link(&real, &l) {
            eprintln!("symlink not permitted, skipped");
            return;
        }
        assert!(is_sensitive_path(&l));
    }

    #[test]
    fn a_link_named_env_is_sensitive() {
        let dir = tempdir();
        let real = dir.join("safe.txt");
        std::fs::write(&real, b"x").unwrap();
        let l = dir.join(".env");
        if !link(&real, &l) {
            eprintln!("symlink not permitted, skipped");
            return;
        }
        assert!(is_sensitive_path(&l));
    }

    #[test]
    fn a_chain_of_links_is_followed() {
        let dir = tempdir();
        let real = dir.join("id_rsa");
        std::fs::write(&real, b"k").unwrap();
        let b = dir.join("b.txt");
        let a = dir.join("a.txt");
        if !link(&real, &b) || !link(&b, &a) {
            eprintln!("symlink not permitted, skipped");
            return;
        }
        assert!(is_sensitive_path(&a));
    }

    #[test]
    fn a_missing_env_is_still_sensitive() {
        assert!(is_sensitive_path(&tempdir().join(".env")));
    }

    #[test]
    fn a_folder_called_env_is_not_sensitive() {
        let dir = tempdir().join(".env");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!is_sensitive_path(&dir));
    }

    #[test]
    fn an_ordinary_file_is_not_sensitive() {
        let f = tempdir().join("a.txt");
        std::fs::write(&f, b"x").unwrap();
        assert!(!is_sensitive_path(&f));
    }

    #[cfg(windows)]
    #[test]
    fn alternate_data_streams_are_sensitive() {
        let dir = tempdir();
        assert!(is_sensitive_path(&dir.join(".env::$DATA")));
        assert!(is_sensitive_path(&dir.join("a.txt:hidden")));
    }

    #[cfg(windows)]
    #[test]
    fn a_trailing_space_name_resolves_to_the_real_file() {
        let dir = tempdir();
        std::fs::write(dir.join(".env"), b"X=1").unwrap();
        assert!(is_sensitive_path(&dir.join(".env ")));
    }
}
