//! Loop guard for the quick assistant's tool loop: warns, then blocks, a model
//! that repeats the same call or goes round in a cycle. Calls are compared by
//! a hash of tool name + canonical arguments (never by name alone: searching a
//! folder then reading a file, twice with different arguments, is legitimate).
//! The guard only ever stops a call from being made; it never runs a tool.
//!
//! Used by `quick_assistant` / `quick_loop`, one [`LoopGuard`] per request.
//! The hashes are only compared within a single process run, so
//! `DefaultHasher` stability across versions does not matter.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};

use serde_json::Value;

/// The call is blocked on the 4th identical call; warned on the 3rd.
pub const MAX_IDENTICAL: u32 = 3;
/// How many most-recent call hashes are kept for cycle detection (enough for
/// two repetitions of a period-3 cycle).
const RECENT: usize = 6;

/// What kind of repetition the guard detected.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LoopKind {
    /// The exact same call (same tool, same arguments) made too many times.
    Identical,
    /// A short pattern of distinct calls (period 2 or 3) repeating.
    Cycle,
}

/// The guard's decision for one call about to be made.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Verdict {
    /// Run the call normally.
    Allow,
    /// Run the call, but append [`warning_text`] to its result.
    Warn(LoopKind),
    /// Do not run the call; the request should be stopped.
    Block(LoopKind),
}

/// Per-request state of the loop detector. Create a fresh one for each user
/// request; it is never shared across requests.
#[derive(Default)]
pub struct LoopGuard {
    /// How many times each call hash has been seen so far.
    counts: HashMap<u64, u32>,
    /// Sliding window of the last [`RECENT`] call hashes, oldest first.
    recent: VecDeque<u64>,
    /// A cycle warning was already issued; the next detection blocks.
    cycle_warned: bool,
}

impl LoopGuard {
    /// Creates an empty guard (no calls seen).
    pub fn new() -> Self {
        Self::default()
    }

    /// Judges one call about to be made. Every call counts, in order.
    ///
    /// Precedence when several conditions hit at once: block-identical, then
    /// block-cycle, then warn-cycle, then warn-identical. Blocked calls still
    /// count, so a model that ignores a block keeps being blocked.
    pub fn check(&mut self, name: &str, args: &Value) -> Verdict {
        let h = call_hash(name, args);
        let n = {
            let c = self.counts.entry(h).or_insert(0);
            *c += 1;
            *c
        };
        self.recent.push_back(h);
        if self.recent.len() > RECENT {
            self.recent.pop_front();
        }

        let block_identical = n > MAX_IDENTICAL;
        let warn_identical = n == MAX_IDENTICAL;

        let (mut warn_cycle, mut block_cycle) = (false, false);
        if self.in_cycle() {
            if self.cycle_warned {
                block_cycle = true;
            } else {
                self.cycle_warned = true;
                warn_cycle = true;
            }
        }

        if block_identical {
            Verdict::Block(LoopKind::Identical)
        } else if block_cycle {
            Verdict::Block(LoopKind::Cycle)
        } else if warn_cycle {
            Verdict::Warn(LoopKind::Cycle)
        } else if warn_identical {
            Verdict::Warn(LoopKind::Identical)
        } else {
            Verdict::Allow
        }
    }

    /// True when the tail of the recent window is a period-2 or period-3
    /// repetition. A single call repeated is excluded here (that is the
    /// `Identical` case, handled by the counters).
    fn in_cycle(&self) -> bool {
        let r: Vec<u64> = self.recent.iter().copied().collect();
        let len = r.len();
        // Period 2: A B A B.
        if len >= 4 && r[len - 4] == r[len - 2] && r[len - 3] == r[len - 1] && r[len - 1] != r[len - 2] {
            return true;
        }
        // Period 3: A B C A B C, but not the same call six times over.
        if len >= 6 && r[len - 6..len - 3] == r[len - 3..] && !(r[len - 3] == r[len - 2] && r[len - 2] == r[len - 1]) {
            return true;
        }
        false
    }
}

/// Objects with sorted keys, recursively; everything else as `serde_json`
/// writes it. `preserve_order` is on, so `{"a":1,"b":2}` and `{"b":2,"a":1}`
/// would otherwise differ.
pub fn canonical_json(v: &Value) -> String {
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .into_iter()
                .map(|k| format!("{}:{}", Value::String(k.clone()), canonical_json(&map[k])))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(canonical_json).collect();
            format!("[{}]", parts.join(","))
        }
        other => other.to_string(),
    }
}

/// Hash identifying a call: tool name, a NUL separator (so `("ab","c")` and
/// `("a","bc")` differ) and the canonical JSON of the arguments.
pub fn call_hash(name: &str, args: &Value) -> u64 {
    let mut h = DefaultHasher::new();
    name.hash(&mut h);
    '\0'.hash(&mut h);
    canonical_json(args).hash(&mut h);
    h.finish()
}

/// Text for the model, appended to the result of the call that drew the warning.
pub fn warning_text(kind: LoopKind) -> &'static str {
    match kind {
        LoopKind::Identical => {
            "[Coucou loop guard: you have now made this exact tool call 3 times. Do not repeat it; another identical call will stop this request.]"
        }
        LoopKind::Cycle => {
            "[Coucou loop guard: your tool calls are going round in a cycle. Change approach or answer with what you have; repeating the cycle will stop this request.]"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use LoopKind::*;
    use Verdict::*;

    fn run_trace(calls: &[(&str, Value)]) -> Vec<Verdict> {
        let mut g = LoopGuard::new();
        calls.iter().map(|(n, a)| g.check(n, a)).collect()
    }

    fn call(tag: &str) -> (&'static str, Value) {
        ("search_files", json!({ "query": tag }))
    }

    #[test]
    fn argument_key_order_does_not_change_the_hash() {
        let a = json!({"query": "x", "folder": "f", "nested": {"b": 1, "a": [1, {"d": 1, "c": 2}]}});
        let b = json!({"nested": {"a": [1, {"c": 2, "d": 1}], "b": 1}, "folder": "f", "query": "x"});
        assert_eq!(call_hash("search_files", &a), call_hash("search_files", &b));
    }

    #[test]
    fn different_arguments_or_tools_hash_differently() {
        let a = json!({"query": "x"});
        assert_ne!(call_hash("search_files", &a), call_hash("search_files", &json!({"query": "y"})));
        assert_ne!(call_hash("search_files", &a), call_hash("read_approved_folder", &a));
    }

    #[test]
    fn the_same_call_four_times_warns_then_blocks() {
        let a = call("a");
        assert_eq!(
            run_trace(&[a.clone(), a.clone(), a.clone(), a.clone()]),
            vec![Allow, Allow, Warn(Identical), Block(Identical)]
        );
    }

    #[test]
    fn a_two_call_cycle_warns_then_blocks() {
        let (a, b) = (call("a"), call("b"));
        assert_eq!(
            run_trace(&[a.clone(), b.clone(), a.clone(), b.clone(), a.clone()]),
            vec![Allow, Allow, Allow, Warn(Cycle), Block(Cycle)]
        );
    }

    #[test]
    fn a_three_call_cycle_warns_then_blocks() {
        let (a, b, c) = (call("a"), call("b"), call("c"));
        assert_eq!(
            run_trace(&[a.clone(), b.clone(), c.clone(), a.clone(), b.clone(), c.clone(), a.clone()]),
            vec![Allow, Allow, Allow, Allow, Allow, Warn(Cycle), Block(Cycle)]
        );
    }

    #[test]
    fn a_search_and_a_read_with_different_arguments_is_not_a_cycle() {
        let calls = [
            ("search_files", json!({"query": "q"})),
            ("read_approved_folder", json!({"path": "a"})),
            ("search_files", json!({"query": "q"})),
            ("read_approved_folder", json!({"path": "b"})),
        ];
        assert_eq!(run_trace(&calls), vec![Allow; 4]);
    }

    #[test]
    fn repeating_one_call_is_never_a_cycle() {
        let a = call("a");
        let calls: Vec<_> = (0..8).map(|_| a.clone()).collect();
        assert!(!run_trace(&calls).contains(&Warn(Cycle)));
        assert!(!run_trace(&calls).contains(&Block(Cycle)));
    }
}
