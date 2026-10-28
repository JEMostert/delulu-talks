//! Dictation context: what the last dictation was about, carried to the next one.
//!
//! Cleanup names a topic; the next dictation gives Whisper the matching shelf's terms and
//! the last sentence as its prompt, so names come out right before cleanup runs. The
//! context lives in memory only: it is empty after a restart, and it expires after a
//! quiet spell or when cleared from the tray.
use super::*;
use delulu_store::Vocabulary;

/// A quiet spell this long ends the context; the next dictation starts fresh.
pub(crate) const EXPIRE: Duration = Duration::from_secs(10 * 60);
/// Whisper reads at most about 224 prompt tokens; stay well under.
const MAX_PROMPT_TERMS: usize = 40;
const MAX_TERM_CHARS: usize = 300;
const MAX_SENTENCE_CHARS: usize = 200;

#[derive(Default)]
pub(crate) struct Context {
    inner: Mutex<Inner>,
}
#[derive(Default)]
struct Inner {
    topic: Option<String>,
    sentence: Option<String>,
    at: Option<Instant>,
    /// Bumped on every change, so a stale expiry timer does nothing.
    generation: u64,
}

impl Context {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn topic(&self) -> Option<String> {
        self.lock().topic.clone()
    }

    /// The Whisper prompt for the next dictation, or None without a live context.
    pub(crate) fn whisper_prompt(&self, vocabulary: &Vocabulary) -> Option<String> {
        let inner = self.lock();
        if inner.at.is_none_or(|at| at.elapsed() >= EXPIRE) {
            return None;
        }
        whisper_prompt(
            inner.topic.as_deref(),
            inner.sentence.as_deref(),
            vocabulary,
        )
    }

    /// Remember a finished dictation. Returns the generation for the expiry timer.
    fn remember(&self, topic: Option<String>, sentence: &str) -> u64 {
        let mut inner = self.lock();
        // A dictation without a topic (cleanup off or unsure) keeps the last one.
        if topic.is_some() {
            inner.topic = topic;
        }
        inner.sentence = Some(sentence.to_string()).filter(|s| !s.trim().is_empty());
        inner.at = Some(Instant::now());
        inner.generation += 1;
        inner.generation
    }

    /// Forget everything; true if there was something to forget.
    fn clear_if(&self, generation: Option<u64>) -> bool {
        let mut inner = self.lock();
        if generation.is_some_and(|g| g != inner.generation) {
            return false;
        }
        let had = inner.at.is_some();
        *inner = Inner {
            generation: inner.generation + 1,
            ..Inner::default()
        };
        had
    }
}

/// Keep what this dictation was about for the next one, and end it after a quiet spell.
pub(crate) fn remember(app: &tauri::AppHandle, topic: Option<String>, sentence: &str) {
    let generation = app.state::<Shell>().context.remember(topic, sentence);
    tray::set_topic(app, app.state::<Shell>().context.topic().as_deref());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(EXPIRE).await;
        if app.state::<Shell>().context.clear_if(Some(generation)) {
            tray::set_topic(&app, None);
        }
    });
}

/// Forget the context now (tray "Clear topic").
pub(crate) fn clear(app: &tauri::AppHandle) {
    app.state::<Shell>().context.clear_if(None);
    tray::set_topic(app, None);
}

/// Topic words that point at a shelf whose name holds another word.
const ALIASES: &[(&str, &[&str])] = &[
    (
        "programming",
        &[
            "coding",
            "code",
            "software",
            "development",
            "it",
            "tech",
            "computers",
        ],
    ),
    ("gaming", &["games", "game", "esports", "discord"]),
    ("streaming", &["stream", "twitch"]),
];

fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(String::from)
        .collect()
}

/// True when a topic like "software development" belongs on a shelf like "Programming".
fn topic_matches(topic: &str, shelf: &str) -> bool {
    let shelf = words(shelf);
    words(topic).iter().any(|word| {
        shelf.contains(word)
            || ALIASES.iter().any(|(name, aliases)| {
                shelf.iter().any(|s| s == name) && aliases.contains(&word.as_str())
            })
    })
}

/// Terms of the enabled shelves matching the topic, then the last sentence: plain words,
/// never instructions, which Whisper reads as the text that came before.
pub(crate) fn whisper_prompt(
    topic: Option<&str>,
    sentence: Option<&str>,
    vocabulary: &Vocabulary,
) -> Option<String> {
    let mut terms: Vec<&str> = Vec::new();
    let mut chars = 0;
    if let Some(topic) = topic {
        let shelf_terms = vocabulary
            .shelves
            .iter()
            .filter(|shelf| shelf.enabled && topic_matches(topic, &shelf.name))
            .flat_map(|shelf| &shelf.terms);
        for term in shelf_terms {
            chars += term.chars().count() + 2;
            if terms.len() == MAX_PROMPT_TERMS || chars > MAX_TERM_CHARS {
                break;
            }
            terms.push(term);
        }
    }
    let sentence = sentence.map(|s| tail(s.trim(), MAX_SENTENCE_CHARS));
    let mut parts = Vec::new();
    if !terms.is_empty() {
        parts.push(format!("{}.", terms.join(", ")));
    }
    if let Some(sentence) = sentence.filter(|s| !s.is_empty()) {
        parts.push(sentence.to_string());
    }
    (!parts.is_empty()).then(|| parts.join(" "))
}

/// The last `max` characters of `text`, starting at a word.
fn tail(text: &str, max: usize) -> &str {
    let count = text.chars().count();
    if count <= max {
        return text;
    }
    let start = text.char_indices().nth(count - max).map_or(0, |(i, _)| i);
    let cut = &text[start..];
    cut.find(' ')
        .map_or(cut, |space| cut[space + 1..].trim_start())
}

#[cfg(test)]
mod tests {
    use super::*;
    use delulu_store::Shelf;

    fn shelf(name: &str, enabled: bool, terms: &[&str]) -> Shelf {
        Shelf {
            id: name.into(),
            name: name.into(),
            enabled,
            terms: terms.iter().map(|t| t.to_string()).collect(),
        }
    }

    fn vocabulary() -> Vocabulary {
        Vocabulary {
            version: 1,
            shelves: vec![
                shelf("Programming", true, &["T3 Code", "Tauri"]),
                shelf("Gaming & Discord", true, &["Valorant", "GG"]),
                shelf("Twitch & Streaming", false, &["OBS"]),
            ],
        }
    }

    #[test]
    fn topics_find_their_shelf() {
        assert!(topic_matches("programming", "Programming"));
        assert!(topic_matches("software development", "Programming"));
        assert!(topic_matches("gaming", "Gaming & Discord"));
        assert!(topic_matches("discord", "Gaming & Discord"));
        assert!(topic_matches("streaming", "Twitch & Streaming"));
        assert!(!topic_matches("finance", "Programming"));
        assert!(!topic_matches("everyday", "Gaming & Discord"));
    }

    #[test]
    fn prompt_is_shelf_terms_then_last_sentence() {
        let v = vocabulary();
        assert_eq!(
            whisper_prompt(Some("programming"), Some("Fix the merge conflict."), &v).as_deref(),
            Some("T3 Code, Tauri. Fix the merge conflict.")
        );
        // No matching shelf: just the sentence. A disabled shelf never counts.
        assert_eq!(
            whisper_prompt(Some("streaming"), Some("Going live."), &v).as_deref(),
            Some("Going live.")
        );
        assert_eq!(
            whisper_prompt(Some("gaming"), None, &v).as_deref(),
            Some("Valorant, GG.")
        );
        assert_eq!(whisper_prompt(None, None, &v), None);
        assert_eq!(whisper_prompt(Some("finance"), Some("  "), &v), None);
    }

    #[test]
    fn long_sentences_keep_their_end_from_a_word() {
        let long = format!("{} the end of it", "word ".repeat(60));
        let prompt = whisper_prompt(None, Some(&long), &Vocabulary::default()).unwrap();
        assert!(prompt.chars().count() <= MAX_SENTENCE_CHARS);
        assert!(prompt.ends_with("the end of it"));
        assert!(prompt.starts_with("word"));
    }

    #[test]
    fn context_keeps_topic_expires_and_clears() {
        let context = Context::default();
        let v = vocabulary();
        assert_eq!(context.whisper_prompt(&v), None, "empty after a restart");
        let first = context.remember(Some("programming".into()), "Open T3 Code.");
        assert_eq!(
            context.whisper_prompt(&v).as_deref(),
            Some("T3 Code, Tauri. Open T3 Code.")
        );
        // A dictation without a topic keeps the topic, with the new sentence.
        let second = context.remember(None, "And run the tests.");
        assert_eq!(context.topic().as_deref(), Some("programming"));
        // The first dictation's timer is stale and does nothing.
        assert!(!context.clear_if(Some(first)));
        assert!(context.clear_if(Some(second)));
        assert_eq!(context.topic(), None);
        assert_eq!(context.whisper_prompt(&v), None);
        // Expired contexts give no prompt even before the timer fires.
        context.remember(Some("gaming".into()), "GG.");
        context.lock().at = Some(Instant::now() - EXPIRE);
        assert_eq!(context.whisper_prompt(&v), None);
    }
}
