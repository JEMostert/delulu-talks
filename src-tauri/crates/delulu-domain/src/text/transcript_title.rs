//! Transcript titles (`src/transcriptTitle.ts`).

use delulu_core::DomainError;
use serde_json::Value;

use crate::js;
use crate::plain_error;

/// Titles are optional single-line metadata, separate from transcript content.
pub fn normalize_transcript_title(value: &Value) -> Result<Option<String>, DomainError> {
    let title = match value {
        Value::Null => return Ok(None),
        Value::String(title) => title,
        _ => return Err(plain_error("A transcript title must be text or null")),
    };
    if js::utf16_len(title) > 256 {
        return Err(plain_error("A transcript title cannot exceed 256 characters"));
    }
    if title.chars().any(|c| matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{2028}' | '\u{2029}')) {
        return Err(plain_error("A transcript title must be a single line without control characters"));
    }
    let trimmed = js::trim(title);
    Ok((!trimmed.is_empty()).then(|| trimmed.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn titles_are_trimmed_single_lines() {
        assert_eq!(normalize_transcript_title(&json!("  Notes ")).unwrap().as_deref(), Some("Notes"));
        assert_eq!(normalize_transcript_title(&json!("   ")).unwrap(), None);
        assert_eq!(normalize_transcript_title(&json!(null)).unwrap(), None);
        assert!(normalize_transcript_title(&json!("a\nb")).is_err());
        assert!(normalize_transcript_title(&json!(3)).is_err());
        assert!(normalize_transcript_title(&json!("😀".repeat(129))).is_err());
    }
}
