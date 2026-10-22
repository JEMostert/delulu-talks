//! Bounded cache of session-only transcripts (`src/sessionTranscriptRetention.ts`).

use std::cmp::Ordering;
use std::collections::HashSet;

use serde_json::Value;

use crate::types::TranscriptRecord;

pub const SESSION_TRANSCRIPT_LIMIT: usize = 20;
pub const SESSION_TRANSCRIPT_TEXT_BYTES: usize = 8 * 1024 * 1024;

fn opt(value: &Option<Option<String>>) -> usize {
    value.as_ref().and_then(Option::as_ref).map_or(0, String::len)
}

/// UTF-8 bytes of every top-level string, including originals, corrections and rewrites.
fn text_bytes(record: &TranscriptRecord) -> usize {
    let enums = [
        record.dictation_formatting.map(|v| v.as_str()),
        record.magic_model.flatten().map(|v| v.as_str()),
        record.magic_preset.flatten().map(|v| v.as_str()),
        Some(record.model.as_str()),
        record.language_status.map(|v| v.as_str()),
        Some(record.source.as_str()),
    ];
    let extra: usize = record.extra.values().map(|value| if let Value::String(text) = value { text.len() } else { 0 }).sum();
    record.id.len()
        + record.text.len()
        + record.language.len()
        + [
            &record.title,
            &record.personalized_text,
            &record.edited_text,
            &record.magic_text,
            &record.requested_language,
            &record.recognized_language,
            &record.source_name,
        ]
        .into_iter()
        .map(opt)
        .sum::<usize>()
        + enums.into_iter().flatten().map(str::len).sum::<usize>()
        + extra
}

/// An approximation of `String.prototype.localeCompare` for identifiers:
/// case-insensitive first, then lowercase before uppercase.
fn locale_compare(a: &str, b: &str) -> Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| b.cmp(a))
}

/// Keep newest session outputs whole; only the newest may exceed the budget.
pub fn retain_session_transcripts(records: &[TranscriptRecord], pinned_ids: &[String]) -> Vec<TranscriptRecord> {
    let pinned: HashSet<&str> = pinned_ids.iter().map(String::as_str).collect();
    let mut sessions: Vec<&TranscriptRecord> =
        records.iter().filter(|record| record.session_only == Some(true) && !pinned.contains(record.id.as_str())).collect();
    sessions.sort_by(|a, b| {
        b.created_at.partial_cmp(&a.created_at).unwrap_or(Ordering::Equal).then_with(|| locale_compare(&b.id, &a.id))
    });
    let mut retained: HashSet<&str> = HashSet::new();
    let mut bytes = 0;
    for record in sessions {
        let size = text_bytes(record);
        if retained.len() >= SESSION_TRANSCRIPT_LIMIT || (!retained.is_empty() && bytes + size > SESSION_TRANSCRIPT_TEXT_BYTES) {
            break;
        }
        retained.insert(&record.id);
        bytes += size;
    }
    records
        .iter()
        .filter(|record| {
            record.session_only != Some(true) || pinned.contains(record.id.as_str()) || retained.contains(record.id.as_str())
        })
        .cloned()
        .collect()
}

/// Saved records belong to disk history, not a second session cache.
/// `records` is an insertion-ordered map keyed by record id.
pub fn remember_session_transcript(records: &mut Vec<TranscriptRecord>, record: TranscriptRecord, pinned_ids: &[String]) {
    if record.session_only != Some(true) {
        // A cached copy of a saved record would shadow later edits on disk.
        records.retain(|item| item.id != record.id);
        return;
    }
    match records.iter_mut().find(|item| item.id == record.id) {
        Some(existing) => *existing = record,
        None => records.push(record),
    }
    let retained: HashSet<String> =
        retain_session_transcripts(records, pinned_ids).into_iter().map(|item| item.id).collect();
    records.retain(|item| retained.contains(&item.id));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ModelId;

    fn transcript(id: &str, created_at: f64) -> TranscriptRecord {
        TranscriptRecord {
            id: id.into(),
            created_at,
            text: "private text".into(),
            session_only: Some(true),
            duration_ms: 1000.0,
            model: ModelId::R2t2,
            language: "en".into(),
            processing_time_ms: 10.0,
            ..TranscriptRecord::default()
        }
    }

    fn ids(records: &[TranscriptRecord]) -> Vec<&str> {
        records.iter().map(|record| record.id.as_str()).collect()
    }

    #[test]
    fn keeps_newest_unpinned_sessions_plus_pins_and_never_caches_saved_records() {
        let sessions: Vec<_> = (0..SESSION_TRANSCRIPT_LIMIT + 3).map(|i| transcript(&format!("session-{i}"), i as f64)).collect();
        let saved = TranscriptRecord { session_only: Some(false), ..transcript("saved", -1.0) };
        let input: Vec<_> = std::iter::once(saved.clone()).chain(sessions.iter().cloned()).collect();
        let pins = ["session-0".to_owned()];
        let retained = retain_session_transcripts(&input, &pins);
        let mut expected = vec!["saved", "session-0"];
        expected.extend(ids(&sessions[3..]));
        assert_eq!(ids(&retained), expected);
        let mut cache = Vec::new();
        for record in &sessions {
            remember_session_transcript(&mut cache, record.clone(), &pins);
        }
        remember_session_transcript(&mut cache, saved, &[]);
        assert_eq!(ids(&cache), expected[1..]);
    }

    #[test]
    fn counts_utf8_originals_and_rewrites_and_keeps_an_oversized_newest_output_whole() {
        let newest = TranscriptRecord { text: "é".repeat(3_000_000), ..transcript("newest", 3.0) };
        let older = TranscriptRecord {
            text: "x".repeat(1_000_000),
            magic_text: Some(Some("é".repeat(1_000_000))),
            ..transcript("older", 2.0)
        };
        let active = transcript("active", 1.0);
        let retained = retain_session_transcripts(&[older.clone(), active.clone(), newest.clone()], std::slice::from_ref(&active.id));
        assert_eq!(ids(&retained), ["active", "newest"]);
        let oversized = TranscriptRecord { text: "x".repeat(SESSION_TRANSCRIPT_TEXT_BYTES + 1), ..transcript("oversized", 4.0) };
        assert_eq!(ids(&retain_session_transcripts(&[older, newest, oversized], &[])), ["oversized"]);
    }
}
