//! Which text of a transcript record is current (`src/transcriptText.ts`).

use crate::js;
use crate::types::TranscriptRecord;

/// The record's source revision; legacy or invalid values count as zero.
pub fn transcript_source_revision(record: &TranscriptRecord) -> u64 {
    match record.source_revision {
        Some(revision) if js::is_safe_integer(revision) && revision >= 0.0 => revision as u64,
        _ => 0,
    }
}

pub fn original_transcript_text(record: &TranscriptRecord) -> &str {
    &record.text
}

/// The correction when there is one (even an empty one), else the original.
pub fn transcript_text(record: &TranscriptRecord) -> &str {
    match &record.edited_text {
        Some(Some(edited)) => edited,
        _ => original_transcript_text(record),
    }
}

pub fn transcript_is_edited(record: &TranscriptRecord) -> bool {
    matches!(record.edited_text, Some(Some(_)))
}

/// What delivery uses: a rewrite of the current source, else the
/// personalized text of an uncorrected record, else the current text.
pub fn delivered_text(record: &TranscriptRecord) -> &str {
    let rewrite_current = match record.rewrite_source_revision {
        Some(Some(revision)) => revision == transcript_source_revision(record) as f64,
        _ => true,
    };
    if rewrite_current {
        if let Some(Some(magic)) = &record.magic_text {
            if !js::trim(magic).is_empty() {
                return magic;
            }
        }
    }
    if !transcript_is_edited(record) {
        if let Some(Some(personalized)) = &record.personalized_text {
            if !personalized.is_empty() {
                return personalized;
            }
        }
    }
    transcript_text(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ModelId;

    fn transcript() -> TranscriptRecord {
        TranscriptRecord {
            id: "record".into(),
            created_at: 1.0,
            duration_ms: 1000.0,
            text: "Original recognition".into(),
            model: ModelId::R2t2,
            language: "en".into(),
            processing_time_ms: 10.0,
            ..TranscriptRecord::default()
        }
    }

    #[test]
    fn delivers_only_current_rewrites_preserves_empty_edits_and_retains_the_original() {
        let record = TranscriptRecord {
            source_revision: Some(2.0),
            edited_text: Some(Some("Corrected source".into())),
            personalized_text: Some(Some("Old personalization".into())),
            magic_text: Some(Some("Old rewrite".into())),
            rewrite_source_revision: Some(Some(1.0)),
            ..transcript()
        };
        assert_eq!(delivered_text(&record), "Corrected source");
        assert_eq!(original_transcript_text(&record), "Original recognition");
        assert_eq!(transcript_text(&record), "Corrected source");
        let current = TranscriptRecord { rewrite_source_revision: Some(Some(2.0)), ..record.clone() };
        assert_eq!(delivered_text(&current), "Old rewrite");
        let emptied = TranscriptRecord { edited_text: Some(Some(String::new())), ..record };
        assert_eq!(delivered_text(&emptied), "");
        let personalized = TranscriptRecord { personalized_text: Some(Some("Personalized".into())), ..transcript() };
        assert_eq!(delivered_text(&personalized), "Personalized");
        let legacy = TranscriptRecord { magic_text: Some(Some("Legacy rewrite".into())), ..transcript() };
        assert_eq!(delivered_text(&legacy), "Legacy rewrite");
        assert_eq!(delivered_text(&transcript()), "Original recognition");
    }
}
