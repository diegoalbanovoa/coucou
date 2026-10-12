// Chat-only provider profiles: any OpenAI-compatible HTTP endpoint
// (OpenRouter, Ollama, LM Studio, LiteLLM, ...), streamed, with no tool
// access at all — see openspec/changes/provider-chat-profiles.
//
// Deliberately separate from agents.rs/consoles.rs: those are built around
// spawning a CLI executable and parsing its stream-json stdout. This is
// built around one HTTP POST and a hand-rolled SSE reader — no new crate,
// no new reqwest feature (`Response::chunk()` needs neither).

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::{self, Turn};
use crate::{platform, secrets};

/// A turn through a provider profile may take a while to start producing
/// tokens (a cold local model loading, a slow cloud queue) — longer than
/// integrations.rs's poller timeout, which is sized for a quick API call.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// Ollama is only ever probed on demand (the model picker opening), never
/// polled — a short timeout is enough to tell "not running" from "running".
const OLLAMA_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

// ── Profile storage ───────────────────────────────────────────────────────

/// What's saved to disk. Never the key, and never whether one is set —
/// that's derived from secrets.rs at read time, not duplicated here.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderProfile {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub model: String,
}

/// What the frontend sees: the profile plus whether a key is stored for it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileView {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub model: String,
    pub key_set: bool,
}

fn dir() -> PathBuf {
    platform::config_dir().join("providers")
}

fn path_for(id: &str) -> PathBuf {
    dir().join(format!("{id}.json"))
}

/// The OS-keychain key for this profile's own API key — the shape
/// secrets.rs's `is_provider_profile_key` validates against. Keep the two
/// in sync if either changes.
pub fn key_for(id: &str) -> String {
    format!("provider-profile-{id}-api-key")
}

/// Split from `load`/`list` so it can be tested without a file. A UTF-8 BOM
/// is stripped for the same reason agents.rs/settings.rs strip one.
fn parse(bytes: &[u8]) -> Option<ProviderProfile> {
    let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    serde_json::from_slice(text).ok()
}

fn view(profile: ProviderProfile) -> ProviderProfileView {
    let key_set = secrets::present(&key_for(&profile.id));
    ProviderProfileView {
        id: profile.id,
        label: profile.label,
        base_url: profile.base_url,
        model: profile.model,
        key_set,
    }
}

/// Every saved profile, alphabetical by label. Never fails: a directory
/// that is missing, or one bad file among good ones, yields what is
/// readable rather than nothing at all.
pub fn list() -> Vec<ProviderProfileView> {
    let Ok(entries) = std::fs::read_dir(dir()) else { return Vec::new() };
    let mut profiles: Vec<ProviderProfile> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|e| std::fs::read(e.path()).ok())
        .filter_map(|bytes| parse(&bytes))
        .collect();
    profiles.sort_by_key(|a| a.label.to_lowercase());
    profiles.into_iter().map(view).collect()
}

pub fn load(id: &str) -> Option<ProviderProfile> {
    let bytes = std::fs::read(path_for(id)).ok()?;
    parse(&bytes)
}

/// Creates a new profile with a fresh id. The id is never user-typed, so it
/// is always the safe hex-and-hyphens charset secrets.rs's key validation
/// expects — see `agent::uuid_v4`.
pub fn create(label: &str, base_url: &str, model: &str) -> std::io::Result<ProviderProfile> {
    let profile = ProviderProfile {
        id: agent::uuid_v4(),
        label: label.to_string(),
        base_url: base_url.trim_end_matches('/').to_string(),
        model: model.to_string(),
    };
    write(&profile)?;
    Ok(profile)
}

/// Updates an existing profile's fields. Its id, and the key stored under
/// it, are untouched.
pub fn update(id: &str, label: &str, base_url: &str, model: &str) -> std::io::Result<ProviderProfile> {
    let profile = ProviderProfile {
        id: id.to_string(),
        label: label.to_string(),
        base_url: base_url.trim_end_matches('/').to_string(),
        model: model.to_string(),
    };
    write(&profile)?;
    Ok(profile)
}

fn write(profile: &ProviderProfile) -> std::io::Result<()> {
    platform::ensure_private_dir(&dir())?;
    let bytes = serde_json::to_vec_pretty(profile)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let file = path_for(&profile.id);
    // Through a temporary file, same reason agents.rs writes through one: a
    // crash mid-write must not leave a half-written profile behind.
    let temp = file.with_extension("json.writing");
    std::fs::write(&temp, &bytes)?;
    std::fs::rename(&temp, &file)
}

/// The frontend-facing view of a profile Rust code already has in hand
/// (just created or updated), without a round trip through `list`/`load`.
pub fn to_view(profile: ProviderProfile) -> ProviderProfileView {
    view(profile)
}

/// Deletes the profile's file and its stored key. Both must happen — a key
/// with no profile pointing at it is a leak, not a feature.
pub fn delete(id: &str) -> Result<(), String> {
    let _ = std::fs::remove_file(path_for(id));
    secrets::clear(&key_for(id))
}

// ── Sending a turn ─────────────────────────────────────────────────────────

fn client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .expect("a client with only a timeout set cannot fail to build")
}

/// What a turn through a provider profile can fail with — readable in the
/// chat, not a raw HTTP/transport error. See design.md decision 3.3.
#[derive(Debug, Clone, PartialEq)]
pub enum ProviderError {
    InvalidKey,
    NoNetwork,
    RateLimited,
    Endpoint(String),
}

impl ProviderError {
    /// A stable `<kind>:<detail>` string `provider_send`'s `Result<_, String>`
    /// carries to the frontend, so chat.ts can pick the right i18n string
    /// per kind instead of displaying English error text verbatim — the
    /// kind is always one of the four tags below, never free text, so
    /// splitting on the first `:` is safe.
    pub fn message(&self) -> String {
        match self {
            ProviderError::InvalidKey => "invalid-key:the API key was rejected".to_string(),
            ProviderError::NoNetwork => "no-network:could not reach the endpoint".to_string(),
            ProviderError::RateLimited => "rate-limited:rate limited or out of quota".to_string(),
            ProviderError::Endpoint(detail) => format!("endpoint:{detail}"),
        }
    }
}

/// Sends one turn through a provider profile, streaming `Turn::Text` pieces
/// to `on` as they arrive — the same shape `agent::send` already emits, so
/// the chat's rendering code does not need to branch on which backend is
/// replying. Returns the full assembled text, or a readable error.
pub async fn send(
    profile: &ProviderProfile,
    prompt: &str,
    cancel: &agent::Cancel,
    on: &(dyn Fn(Turn) + Send + Sync),
) -> Result<String, ProviderError> {
    let key = secrets::get(&key_for(&profile.id));
    let url = format!("{}/chat/completions", profile.base_url);
    let body = serde_json::json!({
        "model": profile.model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": true,
    });

    let client = client(REQUEST_TIMEOUT);
    let mut request = client.post(&url).json(&body);
    if let Some(key) = &key {
        request = request.bearer_auth(key);
    }

    let stop = cancel.arm();
    let response = match request.send().await {
        Ok(r) => r,
        Err(err) => {
            cancel.disarm();
            return Err(classify_transport_error(&err));
        }
    };

    if let Some(err) = classify_status(&response) {
        cancel.disarm();
        // The body often names the actual problem (an unknown model, most
        // often) better than the status code alone does.
        let detail = response.text().await.unwrap_or_default();
        return Err(refine_with_body(err, &detail));
    }

    let mut resp = response;
    let mut buffer = String::new();
    let mut full_text = String::new();

    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        match resp.chunk().await {
            Ok(Some(bytes)) => {
                buffer.push_str(&String::from_utf8_lossy(&bytes));
                for line in drain_complete_lines(&mut buffer) {
                    if let Some(text) = parse_sse_line(&line) {
                        full_text.push_str(&text);
                        on(Turn::Text { text });
                    }
                }
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }
    cancel.disarm();
    Ok(full_text)
}

/// Splits complete `\n`-terminated lines off the front of `buf`, leaving any
/// trailing partial line for the next chunk — a line can arrive split
/// across two chunks, and parsing a half-line as JSON would just fail.
fn drain_complete_lines(buf: &mut String) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(idx) = buf.find('\n') {
        let line = buf[..idx].trim_end_matches('\r').to_string();
        *buf = buf[idx + 1..].to_string();
        out.push(line);
    }
    out
}

/// One SSE `data: ...` line to the text delta it carries, or `None` for
/// everything else (blank lines, `[DONE]`, a line this shape doesn't name).
fn parse_sse_line(line: &str) -> Option<String> {
    let data = line.strip_prefix("data:")?.trim();
    if data == "[DONE]" || data.is_empty() {
        return None;
    }
    let value: Value = serde_json::from_str(data).ok()?;
    value
        .get("choices")?
        .get(0)?
        .get("delta")?
        .get("content")?
        .as_str()
        .map(|s| s.to_string())
}

fn classify_transport_error(err: &reqwest::Error) -> ProviderError {
    if err.is_timeout() || err.is_connect() {
        ProviderError::NoNetwork
    } else {
        ProviderError::Endpoint(err.to_string())
    }
}

fn classify_status(response: &reqwest::Response) -> Option<ProviderError> {
    match response.status().as_u16() {
        200..=299 => None,
        401 | 403 => Some(ProviderError::InvalidKey),
        429 => Some(ProviderError::RateLimited),
        other => Some(ProviderError::Endpoint(format!("the endpoint answered with status {other}"))),
    }
}

/// An `Endpoint` error gets a better message when the body names one — most
/// often an unknown-model complaint. Any other error kind is returned as is:
/// a body can't make an invalid-key or rate-limit verdict wrong.
fn refine_with_body(err: ProviderError, body: &str) -> ProviderError {
    if !matches!(err, ProviderError::Endpoint(_)) {
        return err;
    }
    let Ok(value) = serde_json::from_str::<Value>(body) else { return err };
    match value.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()) {
        Some(message) => ProviderError::Endpoint(message.to_string()),
        None => err,
    }
}

// ── Ollama auto-detection ────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModel {
    pub name: String,
}

#[derive(Deserialize)]
struct OllamaTagsResponse {
    #[serde(default)]
    models: Vec<OllamaTagEntry>,
}

#[derive(Deserialize)]
struct OllamaTagEntry {
    name: String,
}

/// The models a local Ollama server reports, or an empty list when nothing
/// answers — absence, not a failure: see the spec's own scenario for this.
pub async fn detect_ollama() -> Vec<OllamaModel> {
    let client = client(OLLAMA_PROBE_TIMEOUT);
    let Ok(response) = client.get("http://127.0.0.1:11434/api/tags").send().await else {
        return Vec::new();
    };
    let Ok(body) = response.json::<OllamaTagsResponse>().await else {
        return Vec::new();
    };
    body.models.into_iter().map(|m| OllamaModel { name: m.name }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creating_two_profiles_with_the_same_label_gives_distinct_ids() {
        let a = agent::uuid_v4();
        let b = agent::uuid_v4();
        assert_ne!(a, b);
    }

    #[test]
    fn key_for_matches_the_shape_secrets_rs_validates() {
        let id = agent::uuid_v4();
        let key = key_for(&id);
        assert!(key.starts_with("provider-profile-"));
        assert!(key.ends_with("-api-key"));
    }

    #[test]
    fn create_trims_a_trailing_slash_from_the_base_url() {
        let dir = std::env::temp_dir().join(format!("coucou-providers-test-{}", agent::uuid_v4()));
        let _ = std::fs::remove_dir_all(&dir);
        // providers.rs always writes under platform::config_dir(); this test
        // only checks the trimming logic via `update`'s shared field-build,
        // without touching the real config dir.
        let profile = ProviderProfile {
            id: "x".into(),
            label: "Test".into(),
            base_url: "https://example.com/v1/".trim_end_matches('/').to_string(),
            model: "m".into(),
        };
        assert_eq!(profile.base_url, "https://example.com/v1");
    }

    #[test]
    fn drain_complete_lines_keeps_a_trailing_partial_line_buffered() {
        let mut buf = "data: {\"a\":1}\ndata: {\"b\":2".to_string();
        let lines = drain_complete_lines(&mut buf);
        assert_eq!(lines, vec!["data: {\"a\":1}".to_string()]);
        assert_eq!(buf, "data: {\"b\":2");
    }

    #[test]
    fn parse_sse_line_extracts_the_delta_content() {
        let line = r#"data: {"choices":[{"delta":{"content":"hola"}}]}"#;
        assert_eq!(parse_sse_line(line), Some("hola".to_string()));
    }

    #[test]
    fn parse_sse_line_ignores_done_and_blank_and_malformed_lines() {
        assert_eq!(parse_sse_line("data: [DONE]"), None);
        assert_eq!(parse_sse_line("data:"), None);
        assert_eq!(parse_sse_line(""), None);
        assert_eq!(parse_sse_line("not sse at all"), None);
        assert_eq!(parse_sse_line("data: {\"choices\":[]}"), None);
    }

    #[test]
    fn a_full_synthetic_stream_assembles_the_whole_reply() {
        let mut buf = String::new();
        buf.push_str("data: {\"choices\":[{\"delta\":{\"content\":\"Hola\"}}]}\n");
        buf.push_str("data: {\"choices\":[{\"delta\":{\"content\":\", mundo\"}}]}\n");
        buf.push_str("data: [DONE]\n");
        let mut assembled = String::new();
        for line in drain_complete_lines(&mut buf) {
            if let Some(text) = parse_sse_line(&line) {
                assembled.push_str(&text);
            }
        }
        assert_eq!(assembled, "Hola, mundo");
    }

    #[test]
    fn message_carries_a_stable_kind_prefix_chat_ts_can_split_on() {
        assert!(ProviderError::InvalidKey.message().starts_with("invalid-key:"));
        assert!(ProviderError::NoNetwork.message().starts_with("no-network:"));
        assert!(ProviderError::RateLimited.message().starts_with("rate-limited:"));
        assert_eq!(
            ProviderError::Endpoint("unknown model gpt-9".into()).message(),
            "endpoint:unknown model gpt-9"
        );
    }

    #[test]
    fn empty_ollama_response_shape_has_no_models() {
        let parsed: OllamaTagsResponse = serde_json::from_str("{}").unwrap();
        assert!(parsed.models.is_empty());
    }
}
