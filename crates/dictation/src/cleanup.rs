//! Transcript cleanup as the stop path sees it: what to type and store, given what
//! the cleanup model answered.

/// What to paste and store for one dictation.
#[derive(Debug, PartialEq)]
pub struct Cleaned {
    pub text: String,
    pub raw: Option<String>,
    pub cleanup_ms: Option<u64>,
    /// What the model thought the dictation was about.
    pub topic: Option<String>,
}
#[derive(Debug)]
pub enum CleanResult {
    /// Cleanup is off, not ready, or the language isn't supported.
    Skipped,
    /// The helper answered (`None` = keep raw).
    Done(Option<delulu_cleanup::Cleaned>),
    /// The helper failed, or its result is stale.
    Failed,
}
pub fn choose(raw: String, result: CleanResult, ms: u64) -> Cleaned {
    match result {
        CleanResult::Done(Some(clean)) if clean.text != raw => Cleaned {
            text: clean.text,
            raw: Some(raw),
            cleanup_ms: Some(ms),
            topic: clean.topic,
        },
        CleanResult::Done(clean) => Cleaned {
            text: raw,
            raw: None,
            cleanup_ms: Some(ms),
            topic: clean.and_then(|c| c.topic),
        },
        CleanResult::Skipped | CleanResult::Failed => Cleaned {
            text: raw,
            raw: None,
            cleanup_ms: None,
            topic: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chooses_pasted_text_and_history_fields() {
        let raw = || "eh hallo".to_string();
        let done = |text: &str| {
            CleanResult::Done(Some(delulu_cleanup::Cleaned {
                text: text.into(),
                topic: Some("everyday".into()),
            }))
        };
        assert_eq!(
            choose(raw(), done("Hallo."), 300),
            Cleaned {
                text: "Hallo.".into(),
                raw: Some(raw()),
                cleanup_ms: Some(300),
                topic: Some("everyday".into()),
            }
        );
        assert_eq!(
            choose(raw(), done("eh hallo"), 300),
            Cleaned {
                text: raw(),
                raw: None,
                cleanup_ms: Some(300),
                topic: Some("everyday".into()),
            }
        );
        assert_eq!(
            choose(raw(), CleanResult::Done(None), 300),
            Cleaned {
                text: raw(),
                raw: None,
                cleanup_ms: Some(300),
                topic: None,
            }
        );
        let untouched = Cleaned {
            text: raw(),
            raw: None,
            cleanup_ms: None,
            topic: None,
        };
        assert_eq!(choose(raw(), CleanResult::Failed, 300), untouched);
        assert_eq!(choose(raw(), CleanResult::Skipped, 0), untouched);
    }
}
