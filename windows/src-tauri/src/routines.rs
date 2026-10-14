// Scheduled routines (plan v4, Fase 7): the counterpart of OpenJarvis'
// `morning_digest`. A routine is a prompt, a provider profile, a time and some
// days, optionally with a skill and a permission to use the quick assistant's
// tools. The WEBVIEW schedules (src/island/routines.ts, with `setTimeout` and
// local time); RUST runs: it reads the key from the keychain and every tool goes
// through `quick_assistant::dispatch`. Nothing here runs on its own: if Coucou
// is not open at the hour, the routine does not run.
//
// No continuous agents, no background loop.

use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::providers::{self, ProviderProfile};
use crate::quick_loop::{self, ToolCall};
use crate::settings::Settings;
use crate::usage::{self, Usage};
use crate::{agent, integrations, platform, quick_assistant, secrets, skills};

/// What a result keeps of the model's text.
pub const MAX_RESULT_CHARS: usize = 20_000;
/// The most results `recent_results` will give back.
pub const MAX_RESULTS: usize = 50;
/// The results file is compacted to the newest `MAX_RESULTS` once it passes this.
const COMPACT_AT: usize = 200;
const MAX_LABEL_CHARS: usize = 80;
const MAX_PROMPT_CHARS: usize = 8_000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Routine {
    pub id: String,
    pub label: String,
    pub prompt: String,
    pub profile_id: String,
    /// "HH:MM", 24 h, in the user's local time.
    pub time: String,
    /// 0 (Sunday) to 6 (Saturday), like JavaScript's `Date.getDay()`.
    pub days: Vec<u8>,
    /// Whether the routine may use the quick assistant's tools (each action
    /// still asks for its approval).
    pub tools: bool,
    pub skill: Option<String>,
    pub enabled: bool,
}

/// What the settings window sends: `id` empty or absent creates.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RoutineInput {
    pub id: Option<String>,
    pub label: String,
    pub prompt: String,
    pub profile_id: String,
    pub time: String,
    pub days: Vec<u8>,
    pub tools: bool,
    pub skill: Option<String>,
    pub enabled: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineResult {
    pub routine_id: String,
    pub label: String,
    pub at: u64,
    pub ok: bool,
    pub text: String,
    /// `done`, `error`, `refused-paused` or `missed`.
    pub outcome: String,
}

// ── Validation ────────────────────────────────────────────────────────────

/// "HH:MM" with a 24-hour clock.
pub fn valid_time(time: &str) -> bool {
    let b = time.as_bytes();
    if b.len() != 5 || b[2] != b':' || !time.is_ascii() {
        return false;
    }
    let (Ok(h), Ok(m)) = (time[..2].parse::<u8>(), time[3..].parse::<u8>()) else { return false };
    h <= 23 && m <= 59 && b[0].is_ascii_digit() && b[1].is_ascii_digit() && b[3].is_ascii_digit() && b[4].is_ascii_digit()
}

/// At least one day, each 0 to 6.
pub fn valid_days(days: &[u8]) -> bool {
    !days.is_empty() && days.iter().all(|d| *d <= 6)
}

/// An id is the safe hex-and-hyphens charset of `agent::uuid_v4`, since it is
/// part of a file name.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

fn trimmed(s: &str, max: usize) -> String {
    s.trim().chars().take(max).collect()
}

// ── Storage ────────────────────────────────────────────────────────────────

fn config_routines_dir() -> PathBuf {
    platform::config_dir().join("routines")
}

fn local_routines_dir() -> PathBuf {
    platform::local_dir().join("routines")
}

fn file_for(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

fn write_routine(dir: &Path, routine: &Routine) -> std::io::Result<()> {
    platform::ensure_private_dir(dir)?;
    let bytes = serde_json::to_vec_pretty(routine)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let file = file_for(dir, &routine.id);
    // Through a temporary file, as providers.rs does.
    let temp = file.with_extension("json.writing");
    std::fs::write(&temp, &bytes)?;
    std::fs::rename(&temp, &file)
}

fn parse(bytes: &[u8]) -> Option<Routine> {
    let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    serde_json::from_slice(text).ok()
}

/// Every saved routine, by label. A bad file among good ones is skipped.
pub fn list_in(dir: &Path) -> Vec<Routine> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut routines: Vec<Routine> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter(|e| e.path().file_stem().is_some_and(|s| s != "results"))
        .filter_map(|e| std::fs::read(e.path()).ok())
        .filter_map(|b| parse(&b))
        .filter(|r| valid_id(&r.id))
        .collect();
    routines.sort_by_key(|r| r.label.to_lowercase());
    routines
}

pub fn list() -> Vec<Routine> {
    list_in(&config_routines_dir())
}

pub fn load(id: &str) -> Option<Routine> {
    if !valid_id(id) {
        return None;
    }
    parse(&std::fs::read(file_for(&config_routines_dir(), id)).ok()?)
}

/// Creates (no `id`) or updates a routine, after validating the time and days.
pub fn save_in(dir: &Path, input: RoutineInput, new_id: impl FnOnce() -> String) -> Result<Routine, String> {
    if !valid_time(&input.time) {
        return Err("the time must be HH:MM, 24 hours".to_string());
    }
    if !valid_days(&input.days) {
        return Err("pick at least one day, Sunday (0) to Saturday (6)".to_string());
    }
    let label = trimmed(&input.label, MAX_LABEL_CHARS);
    let prompt = trimmed(&input.prompt, MAX_PROMPT_CHARS);
    if label.is_empty() || prompt.is_empty() {
        return Err("a routine needs a label and a prompt".to_string());
    }
    let id = match input.id.filter(|i| !i.is_empty()) {
        Some(id) if valid_id(&id) => id,
        Some(_) => return Err("not a routine id".to_string()),
        None => new_id(),
    };
    let mut days = input.days;
    days.sort_unstable();
    days.dedup();
    let routine = Routine {
        id,
        label,
        prompt,
        profile_id: input.profile_id,
        time: input.time,
        days,
        tools: input.tools,
        skill: input.skill.filter(|s| !s.is_empty()),
        enabled: input.enabled,
    };
    write_routine(dir, &routine).map_err(|e| e.to_string())?;
    Ok(routine)
}

pub fn save(input: RoutineInput) -> Result<Routine, String> {
    save_in(&config_routines_dir(), input, agent::uuid_v4)
}

pub fn delete_in(dir: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("not a routine id".to_string());
    }
    match std::fs::remove_file(file_for(dir, id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn delete(id: &str) -> Result<(), String> {
    delete_in(&config_routines_dir(), id)
}

// ── Results ────────────────────────────────────────────────────────────────

fn results_file(dir: &Path) -> PathBuf {
    dir.join("results.jsonl")
}

fn read_results(dir: &Path) -> Vec<RoutineResult> {
    let Ok(text) = std::fs::read_to_string(results_file(dir)) else { return Vec::new() };
    text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

/// Appends one result as a single `write_all` of one line. Past `COMPACT_AT`
/// the file is rewritten (through a temporary) with only the newest ones, so
/// it cannot grow without bound.
pub fn append_result_in(dir: &Path, mut result: RoutineResult) -> std::io::Result<()> {
    result.text = result.text.chars().take(MAX_RESULT_CHARS).collect();
    platform::ensure_private_dir(dir)?;
    let line = serde_json::to_string(&result).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(results_file(dir))?;
    file.write_all(format!("{line}\n").as_bytes())?;
    drop(file);
    let all = read_results(dir);
    if all.len() > COMPACT_AT {
        let mut bytes = Vec::new();
        for r in &all[all.len() - MAX_RESULTS..] {
            if let Ok(l) = serde_json::to_string(r) {
                bytes.extend_from_slice(l.as_bytes());
                bytes.push(b'\n');
            }
        }
        let temp = results_file(dir).with_extension("jsonl.writing");
        std::fs::write(&temp, bytes)?;
        std::fs::rename(&temp, results_file(dir))?;
    }
    Ok(())
}

/// The newest `limit` results (at most `MAX_RESULTS`), newest first.
pub fn recent_results_in(dir: &Path, limit: usize) -> Vec<RoutineResult> {
    let mut all = read_results(dir);
    all.reverse();
    all.truncate(limit.min(MAX_RESULTS));
    all
}

pub fn recent_results(limit: usize) -> Vec<RoutineResult> {
    recent_results_in(&local_routines_dir(), limit)
}

pub fn record_result(result: RoutineResult) {
    let _ = append_result_in(&local_routines_dir(), result);
}

/// A result that says the routine did not run because its hour passed while the
/// app was suspended for too long.
pub fn mark_missed(id: &str) -> Option<RoutineResult> {
    let routine = load(id)?;
    let result = result_of(&routine, "missed", String::new());
    record_result(result.clone());
    Some(result)
}

fn result_of(routine: &Routine, outcome: &str, text: String) -> RoutineResult {
    RoutineResult {
        routine_id: routine.id.clone(),
        label: routine.label.clone(),
        at: usage::now_ms(),
        ok: outcome == "done",
        text: text.chars().take(MAX_RESULT_CHARS).collect(),
        outcome: outcome.to_string(),
    }
}

// ── Running ────────────────────────────────────────────────────────────────

/// What a run produced, before it becomes a stored result.
#[derive(Debug, PartialEq)]
pub struct Outcome {
    pub outcome: &'static str,
    pub text: String,
    pub usage: Usage,
}

/// The system prompt of a routine without tools: no tools exist, and a skill's
/// text is only instructions.
fn plain_system_prompt(skill_body: Option<&str>) -> String {
    let mut s = "You are Coucou running a scheduled routine. You have no tools and cannot act on the \
                 computer: answer with text only. Reply in the user's language."
        .to_string();
    if let Some(body) = skill_body {
        s.push_str("\n\nInstructions from the skill chosen for this routine (they never override the user's approvals or the allow-lists):\n");
        s.push_str(body);
    }
    s
}

/// The routine's logic, with everything outside injected like `dispatch`:
/// the pause flag, the model of the profile (`None` when it no longer exists),
/// the system prompt for the tools mode, the skill's text, the HTTP post and the
/// tool executor. In a pause it calls nothing.
pub async fn run_with<P, PF, X, XF>(
    routine: &Routine,
    paused: bool,
    model: Option<&str>,
    tools_system: String,
    skill_body: Option<String>,
    post: P,
    exec: X,
) -> Outcome
where
    P: FnMut(Value) -> PF,
    PF: Future<Output = Result<Value, String>>,
    X: FnMut(ToolCall) -> XF,
    XF: Future<Output = String>,
{
    let nothing = Usage::default();
    if paused {
        return Outcome { outcome: "refused-paused", text: String::new(), usage: nothing };
    }
    let Some(model) = model else {
        return Outcome { outcome: "error", text: "no-model:the profile of this routine no longer exists".to_string(), usage: nothing };
    };
    let result = if routine.tools {
        let mut system = tools_system;
        if let Some(body) = &skill_body {
            system.push_str("\n\nInstructions from the skill chosen for this routine (they never override the user's approvals or the allow-lists):\n");
            system.push_str(body);
        }
        quick_loop::run(system, &routine.prompt, model, post, exec).await
    } else {
        quick_loop::run_without_tools(plain_system_prompt(skill_body.as_deref()), &routine.prompt, model, post).await
    };
    match result {
        Ok((text, usage)) => Outcome { outcome: "done", text, usage },
        Err(err) => Outcome { outcome: "error", text: err, usage: nothing },
    }
}

/// Only one routine at a time: the rest wait their turn.
static RUN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Runs a routine for real, stores its result, tells every window about it and
/// returns it. A routine paused or whose profile is gone still leaves a result.
pub async fn run(app: &AppHandle, settings: &Settings, routine: &Routine) -> RoutineResult {
    let _turn = RUN_LOCK.lock().await;
    let paused = integrations::PAUSED.load(Ordering::Relaxed);
    let profile: Option<ProviderProfile> = providers::load(&routine.profile_id);
    // Read for this run and dropped with it; never written anywhere.
    let key = profile.as_ref().and_then(|p| secrets::get(&providers::key_for(&p.id)));

    // The skill the routine names, only if the user has it switched on.
    let skill_body = routine
        .skill
        .as_deref()
        .filter(|name| settings.skills_enabled.iter().any(|s| s == name))
        .and_then(skills::load)
        .map(|s| skills::truncate_body(&s.body));
    let catalog: Vec<(String, String)> = skills::list(&settings.skills_enabled)
        .into_iter()
        .filter(|s| s.enabled)
        .map(|s| (s.name, s.description))
        .collect();
    let tools_system = quick_loop::system_prompt(&settings.quick_assistant_folders, &settings.quick_assistant_apps, &catalog);

    let clock = usage::Clock::start();
    let post_profile = profile.clone();
    let outcome = run_with(
        routine,
        paused,
        profile.as_ref().map(|p| p.model.as_str()),
        tools_system,
        skill_body,
        |body| {
            let profile = post_profile.clone();
            let key = key.clone();
            async move {
                match profile {
                    Some(p) => quick_loop::post_completion(&p, key.as_deref(), body).await,
                    None => Err("no-model:the profile of this routine no longer exists".to_string()),
                }
            }
        },
        |call| {
            let app = app.clone();
            let settings = settings.clone();
            async move { quick_assistant::execute_tool(&app, &call.name, &call.args, &settings).await }
        },
    )
    .await;

    if matches!(outcome.outcome, "done" | "error") {
        app.state::<usage::Ledger>().record(clock.record(
            format!("routine:{}", routine.id),
            routine.label.clone(),
            outcome.usage.clone(),
            outcome.outcome == "done",
        ));
    }
    let result = result_of(routine, outcome.outcome, outcome.text);
    record_result(result.clone());
    let _ = app.emit("routine-result", result.clone());
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("coucou-routines-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn input(time: &str, days: Vec<u8>) -> RoutineInput {
        RoutineInput {
            label: "Digest".into(),
            prompt: "Summarize my morning".into(),
            profile_id: "p".into(),
            time: time.into(),
            days,
            enabled: true,
            ..Default::default()
        }
    }

    fn routine(tools: bool) -> Routine {
        Routine {
            id: "abc-1".into(),
            label: "Digest".into(),
            prompt: "go".into(),
            profile_id: "p".into(),
            time: "08:00".into(),
            days: vec![1],
            tools,
            skill: None,
            enabled: true,
        }
    }

    #[test]
    fn the_time_is_hh_mm_on_a_24_hour_clock() {
        for ok in ["00:00", "08:05", "23:59"] {
            assert!(valid_time(ok), "{ok}");
        }
        for bad in ["", "8:05", "24:00", "12:60", "12-30", "ab:cd", "12:3", "12:300", "１２:３０"] {
            assert!(!valid_time(bad), "{bad:?}");
        }
    }

    #[test]
    fn days_are_not_empty_and_at_most_six() {
        assert!(valid_days(&[0, 3, 6]));
        assert!(!valid_days(&[]));
        assert!(!valid_days(&[1, 7]));
    }

    #[test]
    fn save_validates_then_stores_and_lists() {
        let d = scratch("save");
        assert!(save_in(&d, input("25:00", vec![1]), || "a1".into()).is_err());
        assert!(save_in(&d, input("08:00", vec![]), || "a1".into()).is_err());
        let saved = save_in(&d, input("08:00", vec![3, 1, 1]), || "a1".into()).unwrap();
        assert_eq!(saved.days, [1, 3]);
        assert_eq!(list_in(&d), vec![saved.clone()]);
        // Saving again with its id updates in place.
        let mut again = input("09:30", vec![2]);
        again.id = Some("a1".into());
        save_in(&d, again, || unreachable!()).unwrap();
        assert_eq!(list_in(&d)[0].time, "09:30");
        delete_in(&d, "a1").unwrap();
        assert!(list_in(&d).is_empty());
    }

    #[test]
    fn an_id_that_is_a_path_is_refused() {
        let d = scratch("id");
        let mut bad = input("08:00", vec![1]);
        bad.id = Some("../x".into());
        assert!(save_in(&d, bad, || "a".into()).is_err());
        assert!(delete_in(&d, "../x").is_err());
    }

    #[test]
    fn results_are_capped_trimmed_and_newest_first() {
        let d = scratch("results");
        for i in 0..(COMPACT_AT + 5) {
            let r = RoutineResult {
                routine_id: "r".into(),
                label: format!("n{i}"),
                at: i as u64,
                ok: true,
                text: "x".repeat(MAX_RESULT_CHARS + 10),
                outcome: "done".into(),
            };
            append_result_in(&d, r).unwrap();
        }
        let got = recent_results_in(&d, 500);
        assert_eq!(got.len(), MAX_RESULTS);
        assert_eq!(got[0].label, format!("n{}", COMPACT_AT + 4));
        assert_eq!(got[0].text.chars().count(), MAX_RESULT_CHARS);
        assert_eq!(recent_results_in(&d, 3).len(), 3);
        assert!(read_results(&d).len() <= COMPACT_AT, "the file is compacted");
    }

    #[tokio::test]
    async fn in_a_pause_nothing_is_called() {
        let out = run_with(
            &routine(true),
            true,
            Some("m"),
            "sys".into(),
            None,
            |_| async { panic!("a paused routine must not post") as Result<Value, String> },
            |_| async { panic!("a paused routine must not run a tool") },
        )
        .await;
        assert_eq!(out.outcome, "refused-paused");
    }

    #[tokio::test]
    async fn a_missing_profile_is_a_no_model_error() {
        let out = run_with(
            &routine(false),
            false,
            None,
            "sys".into(),
            None,
            |_| async { panic!("no model: nothing to post to") as Result<Value, String> },
            |_| async { String::new() },
        )
        .await;
        assert_eq!(out.outcome, "error");
        assert!(out.text.starts_with("no-model:"));
    }

    #[tokio::test]
    async fn without_tools_one_request_goes_out_with_no_tools_field() {
        let sent = std::cell::RefCell::new(Vec::new());
        let out = run_with(
            &routine(false),
            false,
            Some("m"),
            "sys".into(),
            Some("be brief".into()),
            |body| {
                sent.borrow_mut().push(body);
                async { Ok(json!({"choices": [{"message": {"content": "good morning"}}]})) }
            },
            |_| async { panic!("no tools in this mode") },
        )
        .await;
        assert_eq!((out.outcome, out.text.as_str()), ("done", "good morning"));
        let sent = sent.borrow();
        assert_eq!(sent.len(), 1);
        assert!(sent[0].get("tools").is_none());
        assert!(sent[0]["messages"][0]["content"].as_str().unwrap().contains("be brief"));
    }

    #[tokio::test]
    async fn with_tools_the_loop_runs_and_a_tool_goes_through_the_executor() {
        let calls = std::cell::RefCell::new(Vec::new());
        let step = std::cell::Cell::new(0);
        let out = run_with(
            &routine(true),
            false,
            Some("m"),
            "sys".into(),
            None,
            |body| {
                assert!(body["tools"].is_array());
                let n = step.get();
                step.set(n + 1);
                async move {
                    if n == 0 {
                        Ok(json!({"choices": [{"message": {"tool_calls": [
                            {"id": "c", "function": {"name": "query_vault", "arguments": "{}"}}]}}]}))
                    } else {
                        Ok(json!({"choices": [{"message": {"content": "done"}}]}))
                    }
                }
            },
            |call| {
                calls.borrow_mut().push(call.name.clone());
                async { "briefing".to_string() }
            },
        )
        .await;
        assert_eq!(out.outcome, "done");
        assert_eq!(*calls.borrow(), ["query_vault"]);
    }

    #[tokio::test]
    async fn a_routine_whose_model_repeats_a_call_ends_in_a_loop_guard_error() {
        let out = run_with(
            &routine(true),
            false,
            Some("m"),
            "sys".into(),
            None,
            |_| async {
                Ok(json!({"choices": [{"message": {"tool_calls": [
                    {"id": "c", "function": {"name": "query_vault", "arguments": "{}"}}]}}]}))
            },
            |_| async { "briefing".to_string() },
        )
        .await;
        assert_eq!(out.outcome, "error");
        assert!(out.text.starts_with("loop-guard:"));
    }

    #[tokio::test]
    async fn an_endpoint_error_is_an_error_outcome() {
        let out = run_with(
            &routine(false),
            false,
            Some("m"),
            "sys".into(),
            None,
            |_| async { Err("invalid-key:the API key was rejected".to_string()) },
            |_| async { String::new() },
        )
        .await;
        assert_eq!(out.outcome, "error");
        assert!(out.text.starts_with("invalid-key:"));
    }
}
