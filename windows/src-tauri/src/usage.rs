//! What each backend has been asked and how it went: turns, latency, tokens
//! and -- only when the source reports one -- cost. Kept in memory for the
//! session (nothing is written to disk, nothing leaves the machine) and shown
//! in System -> Usage. See docs/plan-v4-notas.md, Fase 4.
//!
//! Energy is deliberately not measured: it cannot be done reliably without
//! hardware counters. Cost is never computed from a price table, only passed
//! through when the endpoint or the CLI says what the turn cost.
//!
//! Recorders: the agent chat, provider chat, the quick assistant and routines
//! each build a [`Clock`], then push a [`TurnRecord`] into the shared [`Ledger`]
//! (Tauri managed state). The Ledger holds at most [`LEDGER_CAP`] turns.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use serde_json::Value;

/// The ledger keeps the most recent turns and forgets the oldest.
pub const LEDGER_CAP: usize = 500;

/// Token counts and cost reported for a turn. Each field is `None` until a source
/// reports it, so "unknown" is never confused with zero.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
}

impl Usage {
    /// Adds what another round reported; a field stays `None` until someone
    /// reports it.
    pub fn add(&mut self, other: &Usage) {
        self.input_tokens = sum_opt(self.input_tokens, other.input_tokens);
        self.output_tokens = sum_opt(self.output_tokens, other.output_tokens);
        self.cost_usd = match (self.cost_usd, other.cost_usd) {
            (None, None) => None,
            (a, b) => Some(a.unwrap_or(0.0) + b.unwrap_or(0.0)),
        };
    }

    /// True when nothing at all was reported.
    pub fn is_empty(&self) -> bool {
        *self == Usage::default()
    }
}

/// Sums two optional counts; stays `None` only if both are `None`.
fn sum_opt(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    match (a, b) {
        (None, None) => None,
        (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
    }
}

/// The OpenAI-shaped `usage` object of a response (or of the last streamed
/// chunk): `prompt_tokens`, `completion_tokens` and, on OpenRouter, `cost`.
/// `None` when there is no `usage` object or it carries none of the three.
pub fn from_openai_usage(value: &Value) -> Option<Usage> {
    let usage = value.get("usage")?;
    if !usage.is_object() {
        return None;
    }
    let found = Usage {
        input_tokens: usage.get("prompt_tokens").and_then(Value::as_u64),
        output_tokens: usage.get("completion_tokens").and_then(Value::as_u64),
        cost_usd: usage.get("cost").and_then(Value::as_f64),
    };
    // OpenJarvis in `-a simple` mode answers 0/0 with no cost: that is "no
    // data", not a real zero. A lone 0 next to a real number stays.
    let all_zero = found.input_tokens == Some(0) && found.output_tokens == Some(0);
    if found.is_empty() || (all_zero && found.cost_usd.is_none()) {
        None
    } else {
        Some(found)
    }
}

/// One finished turn as stored in the [`Ledger`].
#[derive(Clone, Debug, PartialEq)]
pub struct TurnRecord {
    /// `cli:<id>`, `provider:<profile id>`, `quick:<profile id>` or, later,
    /// `routine:<id>`.
    pub backend: String,
    pub label: String,
    /// When the turn finished, in ms since the Unix epoch.
    pub at_ms: u64,
    /// Latency to the first streamed text, if the backend streamed any.
    pub first_text_ms: Option<u64>,
    /// Total duration of the turn in ms.
    pub total_ms: u64,
    pub usage: Usage,
    /// False for turns that ended in an error.
    pub ok: bool,
}

/// Per-backend aggregate sent to the System -> Usage view.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackendSummary {
    pub backend: String,
    pub label: String,
    pub turns: usize,
    pub errors: usize,
    /// Median time to first text, over the turns that had one.
    pub p50_first_text_ms: Option<u64>,
    /// Median total duration.
    pub p50_total_ms: u64,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
}

/// In-memory, bounded log of turns shared across threads. Never persisted.
#[derive(Default)]
pub struct Ledger(Mutex<VecDeque<TurnRecord>>);

impl Ledger {
    /// Appends a turn, dropping the oldest beyond [`LEDGER_CAP`].
    pub fn record(&self, r: TurnRecord) {
        let mut turns = self.0.lock().unwrap();
        turns.push_back(r);
        while turns.len() > LEDGER_CAP {
            turns.pop_front();
        }
    }

    /// Forgets every recorded turn (the "clear" button in the Usage view).
    pub fn reset(&self) {
        self.0.lock().unwrap().clear();
    }

    /// One row per backend, in the order each first appeared.
    pub fn summary(&self) -> Vec<BackendSummary> {
        let turns = self.0.lock().unwrap();
        let mut order: Vec<&str> = Vec::new();
        for t in turns.iter() {
            if !order.contains(&t.backend.as_str()) {
                order.push(&t.backend);
            }
        }
        order
            .into_iter()
            .map(|backend| {
                let mine: Vec<&TurnRecord> = turns.iter().filter(|t| t.backend == backend).collect();
                let mut firsts: Vec<u64> = mine.iter().filter_map(|t| t.first_text_ms).collect();
                let mut totals: Vec<u64> = mine.iter().map(|t| t.total_ms).collect();
                let mut sum = Usage::default();
                for t in &mine {
                    sum.add(&t.usage);
                }
                BackendSummary {
                    backend: backend.to_string(),
                    // The newest label: a renamed profile shows its new name.
                    label: mine.last().map(|t| t.label.clone()).unwrap_or_default(),
                    turns: mine.len(),
                    errors: mine.iter().filter(|t| !t.ok).count(),
                    p50_first_text_ms: p50(&mut firsts),
                    p50_total_ms: p50(&mut totals).unwrap_or(0),
                    input_tokens: sum.input_tokens,
                    output_tokens: sum.output_tokens,
                    cost_usd: sum.cost_usd,
                }
            })
            .collect()
    }
}

/// The median; with an even count, the mean of the two middle values
/// (rounded down). `None` for no values. Sorts `values` in place.
pub fn p50(values: &mut [u64]) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    let mid = values.len() / 2;
    Some(if values.len() % 2 == 1 { values[mid] } else { (values[mid - 1] + values[mid]) / 2 })
}

/// Times one turn: from `start` to the first text and to the end. Cloned into
/// the streaming callback, which marks the first text from another thread.
#[derive(Clone)]
pub struct Clock {
    began: Instant,
    first: Arc<AtomicU64>,
}

/// Sentinel meaning no text has been marked yet.
const UNSET: u64 = u64::MAX;

impl Clock {
    /// Starts timing now.
    pub fn start() -> Self {
        Clock { began: Instant::now(), first: Arc::new(AtomicU64::new(UNSET)) }
    }

    /// Only the first call counts.
    pub fn mark_text(&self) {
        let now = self.began.elapsed().as_millis() as u64;
        let _ = self.first.compare_exchange(UNSET, now, Ordering::SeqCst, Ordering::SeqCst);
    }

    /// Ms from start to the first marked text, or `None` if none yet.
    pub fn first_text_ms(&self) -> Option<u64> {
        match self.first.load(Ordering::SeqCst) {
            UNSET => None,
            ms => Some(ms),
        }
    }

    /// Ms elapsed since start.
    pub fn total_ms(&self) -> u64 {
        self.began.elapsed().as_millis() as u64
    }

    /// The finished turn, ready for the ledger.
    pub fn record(&self, backend: String, label: String, usage: Usage, ok: bool) -> TurnRecord {
        TurnRecord {
            backend,
            label,
            at_ms: now_ms(),
            first_text_ms: self.first_text_ms(),
            total_ms: self.total_ms(),
            usage,
            ok,
        }
    }
}

/// Milliseconds since the Unix epoch, for `TurnRecord::at_ms`.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(backend: &str, total: u64, usage: Usage, ok: bool) -> TurnRecord {
        TurnRecord {
            backend: backend.into(),
            label: backend.into(),
            at_ms: 0,
            first_text_ms: Some(total / 2),
            total_ms: total,
            usage,
            ok,
        }
    }

    fn tokens(i: u64, o: u64) -> Usage {
        Usage { input_tokens: Some(i), output_tokens: Some(o), cost_usd: None }
    }

    #[test]
    fn the_clock_keeps_only_the_first_text() {
        let clock = Clock::start();
        assert_eq!(clock.first_text_ms(), None);
        clock.mark_text();
        let first = clock.first_text_ms();
        assert!(first.is_some());
        std::thread::sleep(std::time::Duration::from_millis(5));
        clock.mark_text();
        assert_eq!(clock.first_text_ms(), first);
        assert!(clock.total_ms() >= first.unwrap());
    }

    #[test]
    fn the_ledger_keeps_only_the_newest_turns() {
        let ledger = Ledger::default();
        for i in 0..(LEDGER_CAP as u64 + 10) {
            ledger.record(rec("cli:claude", i, Usage::default(), true));
        }
        let s = ledger.summary();
        assert_eq!(s[0].turns, LEDGER_CAP);
        // The ten oldest (totals 0..9) are gone, so the median moved up.
        assert!(s[0].p50_total_ms >= 10);
    }

    #[test]
    fn p50_of_an_odd_and_an_even_count() {
        assert_eq!(p50(&mut [30, 10, 20]), Some(20));
        assert_eq!(p50(&mut [40, 10, 20, 30]), Some(25));
        assert_eq!(p50(&mut [7]), Some(7));
        assert_eq!(p50(&mut []), None);
    }

    #[test]
    fn sums_stay_none_until_somebody_reports() {
        let ledger = Ledger::default();
        ledger.record(rec("provider:a", 100, Usage::default(), true));
        ledger.record(rec("provider:a", 100, Usage::default(), true));
        let s = &ledger.summary()[0];
        assert_eq!((s.input_tokens, s.output_tokens, s.cost_usd), (None, None, None));
    }

    #[test]
    fn sums_skip_the_turns_that_reported_nothing() {
        let ledger = Ledger::default();
        ledger.record(rec("provider:a", 100, tokens(10, 5), true));
        ledger.record(rec("provider:a", 100, Usage::default(), true));
        ledger.record(rec(
            "provider:a",
            100,
            Usage { input_tokens: Some(1), output_tokens: None, cost_usd: Some(0.25) },
            true,
        ));
        let s = &ledger.summary()[0];
        assert_eq!(s.input_tokens, Some(11));
        assert_eq!(s.output_tokens, Some(5));
        assert_eq!(s.cost_usd, Some(0.25));
        assert_eq!(s.turns, 3);
    }

    #[test]
    fn turns_are_grouped_by_backend_in_first_seen_order() {
        let ledger = Ledger::default();
        ledger.record(rec("quick:q", 10, Usage::default(), true));
        ledger.record(rec("cli:claude", 20, Usage::default(), false));
        ledger.record(rec("quick:q", 30, Usage::default(), true));
        let s = ledger.summary();
        assert_eq!(s.iter().map(|r| r.backend.as_str()).collect::<Vec<_>>(), ["quick:q", "cli:claude"]);
        assert_eq!((s[0].turns, s[0].errors), (2, 0));
        assert_eq!((s[1].turns, s[1].errors), (1, 1));
        ledger.reset();
        assert!(ledger.summary().is_empty());
    }

    #[test]
    fn an_openai_usage_object_is_read_with_or_without_cost() {
        let v: Value = serde_json::from_str(r#"{"usage":{"prompt_tokens":12,"completion_tokens":3,"cost":0.0004}}"#).unwrap();
        assert_eq!(
            from_openai_usage(&v),
            Some(Usage { input_tokens: Some(12), output_tokens: Some(3), cost_usd: Some(0.0004) })
        );
        let v: Value = serde_json::from_str(r#"{"usage":{"prompt_tokens":1,"completion_tokens":2}}"#).unwrap();
        assert_eq!(from_openai_usage(&v).unwrap().cost_usd, None);
        let none: Value = serde_json::from_str(r#"{"choices":[]}"#).unwrap();
        assert_eq!(from_openai_usage(&none), None);
        let null: Value = serde_json::from_str(r#"{"usage":null}"#).unwrap();
        assert_eq!(from_openai_usage(&null), None);
        // OpenJarvis `-a simple`: 0/0 and no cost means "no data".
        let zeros: Value = serde_json::from_str(r#"{"usage":{"prompt_tokens":0,"completion_tokens":0}}"#).unwrap();
        assert_eq!(from_openai_usage(&zeros), None);
        let half: Value = serde_json::from_str(r#"{"usage":{"prompt_tokens":10,"completion_tokens":0}}"#).unwrap();
        assert_eq!(from_openai_usage(&half), Some(Usage { input_tokens: Some(10), output_tokens: Some(0), cost_usd: None }));
    }
}
