// API keys live in the Windows Credential Manager or, on Linux, the Secret
// Service (GNOME Keyring, KWallet) — never on disk and never in the front end — the island can only ask whether a key is present.

use keyring::Entry;

const SERVICE: &str = "fr.louisraille.coucou";

/// Every key Coucou may store. Anything outside this list is refused.
pub const KNOWN_KEYS: &[&str] = &[
    "anthropic-api-key",
    "n8n-url",
    "n8n-api-key",
    "vercel-token",
    "github-token",
    "stripe-api-key",
    "resend-api-key",
    "notion-api-key",
    "calcom-api-key",
];

/// A provider profile's own key, e.g. "provider-profile-abc123-api-key" —
/// see openspec/changes/provider-chat-profiles. The slug between the two
/// fixed parts is generated at profile-creation time (providers.rs), never
/// typed by the user, so checking its charset here is a second line of
/// defence, not the only one.
fn is_provider_profile_key(key: &str) -> bool {
    let Some(slug) = key.strip_prefix("provider-profile-").and_then(|s| s.strip_suffix("-api-key"))
    else {
        return false;
    };
    !slug.is_empty()
        && slug.len() <= 64
        && slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn entry(key: &str) -> Option<Entry> {
    if !KNOWN_KEYS.contains(&key) && !is_provider_profile_key(key) {
        return None;
    }
    Entry::new(SERVICE, key).ok()
}

pub fn get(key: &str) -> Option<String> {
    entry(key)?.get_password().ok().filter(|v| !v.is_empty())
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    if value.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(value).map_err(|e| e.to_string())
}

pub fn clear(key: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn present(key: &str) -> bool {
    get(key).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_nine_known_keys_are_still_accepted() {
        for key in KNOWN_KEYS {
            assert!(entry(key).is_some(), "{key} should still be accepted");
        }
    }

    #[test]
    fn an_unknown_fixed_key_is_refused() {
        assert!(entry("totally-made-up-key").is_none());
    }

    #[test]
    fn a_well_formed_provider_profile_key_is_accepted() {
        assert!(entry("provider-profile-abc123-api-key").is_some());
        assert!(entry("provider-profile-a-api-key").is_some());
    }

    #[test]
    fn a_provider_profile_key_with_bad_characters_is_refused() {
        assert!(entry("provider-profile-ABC-api-key").is_none(), "uppercase");
        assert!(entry("provider-profile-abc_123-api-key").is_none(), "underscore");
        assert!(entry("provider-profile- -api-key").is_none(), "space");
        assert!(entry("provider-profile-../../etc-api-key").is_none(), "traversal-looking slug");
    }

    #[test]
    fn a_provider_profile_key_with_an_empty_or_oversized_slug_is_refused() {
        assert!(entry("provider-profile--api-key").is_none(), "empty slug");
        let huge = "a".repeat(65);
        assert!(entry(&format!("provider-profile-{huge}-api-key")).is_none());
        let max = "a".repeat(64);
        assert!(entry(&format!("provider-profile-{max}-api-key")).is_some());
    }

    #[test]
    fn missing_the_fixed_prefix_or_suffix_is_refused() {
        assert!(entry("profile-abc-api-key").is_none(), "missing provider- prefix word");
        assert!(entry("provider-profile-abc-key").is_none(), "missing -api- in suffix");
        assert!(entry("provider-profile-abc").is_none(), "missing suffix entirely");
    }
}
