//! Vocabulary rule match counts (`ruleUsage.ts`).
//!
//! Aggregate match counts only: never stores text, event times or transcript IDs.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use delulu_core::util::{publish, stage_private, utf16_len};
use delulu_core::DomainResult;
use delulu_domain::RuleUsage;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};

use crate::json as js;

const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Default)]
struct State {
    /// Insertion-ordered, like the TypeScript object written to disk.
    counts: Map<String, Value>,
    error: Option<String>,
    corrupt: bool,
    missed: bool,
}

pub struct RuleUsageService {
    path: PathBuf,
    state: Mutex<State>,
}

fn load(path: &Path) -> Result<Map<String, Value>, Option<()>> {
    let metadata = fs::metadata(path).map_err(|error| (error.kind() != std::io::ErrorKind::NotFound).then_some(()))?;
    if metadata.len() > 1024 * 1024 {
        return Err(Some(()));
    }
    let text = fs::read_to_string(path).map_err(|_| Some(()))?;
    let value: Value = serde_json::from_str(&text).map_err(|_| Some(()))?;
    let source = value.as_object().ok_or(Some(()))?;
    let counts = match source.get("counts") {
        Some(Value::Object(counts)) => counts,
        _ => return Err(Some(())),
    };
    if source.get("version").and_then(Value::as_f64) != Some(1.0)
        || source.keys().any(|key| key != "version" && key != "counts")
        || counts.len() > 500
        || counts.iter().any(|(id, count)| {
            id.is_empty()
                || utf16_len(id) > 128
                || !count.as_f64().is_some_and(|c| delulu_domain::js::is_safe_integer(c) && c >= 0.0)
        })
    {
        return Err(Some(()));
    }
    Ok(counts.clone())
}

impl RuleUsageService {
    pub fn new(data_directory: &Path) -> Self {
        let path = data_directory.join("rule-usage.json");
        let mut state = State::default();
        match load(&path) {
            Ok(counts) => state.counts = counts,
            Err(None) => {}
            Err(Some(())) => {
                state.corrupt = true;
                state.error = Some(
                    "Local rule counts could not be read. The existing file is preserved; reset counts explicitly to start again."
                        .into(),
                );
            }
        }
        Self { path, state: Mutex::new(state) }
    }

    pub fn get(&self, rule_ids: &[String]) -> RuleUsage {
        let state = self.state.lock();
        let counts: BTreeMap<String, u64> = rule_ids
            .iter()
            .take(500)
            .map(|id| (id.clone(), state.counts.get(id).and_then(Value::as_u64).unwrap_or(0)))
            .collect();
        RuleUsage { counts, error: state.error.clone() }
    }

    /// Adds match counts for the current rules. Never fails: optional
    /// statistics must not turn a usable transcript into a failure.
    pub fn record(&self, matches: &HashMap<String, u64>, current_rule_ids: &[String]) {
        let mut state = self.state.lock();
        if state.corrupt || matches.is_empty() {
            return;
        }
        let mut next = Map::new();
        for id in current_rule_ids.iter().take(500) {
            let increment = matches.get(id).copied().filter(|c| *c <= MAX_SAFE).unwrap_or(0);
            let previous = state.counts.get(id).and_then(Value::as_u64).unwrap_or(0);
            next.insert(id.clone(), json!(previous.saturating_add(increment).min(MAX_SAFE)));
        }
        if self.write(&mut state, next).is_err() {
            state.missed = true;
            state.error =
                Some("Local rule counts could not be saved. Transcription is unaffected; counts may be incomplete.".into());
        }
    }

    pub fn reset(&self) -> DomainResult<()> {
        let mut state = self.state.lock();
        self.write(&mut state, Map::new())?;
        state.corrupt = false;
        state.missed = false;
        state.error = None;
        Ok(())
    }

    fn write(&self, state: &mut State, next: Map<String, Value>) -> std::io::Result<()> {
        let mut text = js::stringify(&json!({"version": 1, "counts": next}));
        text.push('\n');
        let temporary = stage_private(&self.path, text.as_bytes())?;
        publish(&temporary, &self.path)?;
        state.counts = next;
        state.error = state
            .missed
            .then(|| "Some local rule counts were not saved earlier. Counts may be incomplete until reset.".into());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_accumulate_and_corrupt_files_are_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let usage = RuleUsageService::new(dir.path());
        let ids = vec!["a".to_owned(), "b".to_owned()];
        usage.record(&HashMap::from([("a".to_owned(), 2)]), &ids);
        usage.record(&HashMap::from([("a".to_owned(), 1), ("b".to_owned(), 4)]), &ids);
        assert_eq!(usage.get(&ids).counts, BTreeMap::from([("a".to_owned(), 3), ("b".to_owned(), 4)]));
        assert_eq!(fs::read_to_string(dir.path().join("rule-usage.json")).unwrap(), "{\"version\":1,\"counts\":{\"a\":3,\"b\":4}}\n");
        fs::write(dir.path().join("rule-usage.json"), "{oops").unwrap();
        let corrupt = RuleUsageService::new(dir.path());
        assert!(corrupt.get(&ids).error.is_some());
        corrupt.record(&HashMap::from([("a".to_owned(), 1)]), &ids);
        assert_eq!(fs::read_to_string(dir.path().join("rule-usage.json")).unwrap(), "{oops");
        corrupt.reset().unwrap();
        assert!(corrupt.get(&ids).error.is_none());
    }
}
