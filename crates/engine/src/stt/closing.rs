//! Closing phrases standing in for a short clip.
//!
//! Whisper learned from subtitles, which end with "Dank u wel." or "Thank you.", and it
//! sometimes writes just that for a clip that says something else: "Het is een schande
//! dat wij in deze positie zitten." came out as "Dank u wel." People say these phrases
//! too, so the text alone decides nothing. When a whole piece comes out as one, the
//! engine asks Whisper again (see `recheck_closing` in the crate root), and keeps the
//! phrase unless the second answer has more to say.
use std::ffi::c_void;
use std::os::raw::c_int;
use whisper_rs_sys as sys;

/// Whisper's subtitle endings, as plain lowercase words. "you" is what is left of
/// "Thank you" on a short or noisy clip.
const PHRASES: &[&str] = &[
    "dank u wel",
    "dank je wel",
    "dankjewel",
    "dankuwel",
    "bedankt",
    "bedankt voor het kijken",
    "bedankt voor het luisteren",
    "thank you",
    "thank you very much",
    "thank you so much",
    "thanks",
    "thanks for watching",
    "thank you for watching",
    "bye",
    "you",
];

/// Clearly more speech than any of the phrases takes: they last at most about 1.2 s.
pub(crate) const LONGER_THAN_A_PHRASE_S: f32 = 1.5;

fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(String::from)
        .collect()
}

/// True when `text` is nothing but closing phrases ("Dank u wel. Dank u wel.").
pub(crate) fn only_closing(text: &str) -> bool {
    let words = words(text);
    let mut at = 0;
    while at < words.len() {
        // The longest phrase that matches here, so "thank you very much" beats "thank you".
        let matched = PHRASES
            .iter()
            .map(|p| p.split(' ').collect::<Vec<_>>())
            .filter(|p| {
                p.len() <= words.len() - at && p.iter().zip(&words[at..]).all(|(a, b)| a == b)
            })
            .map(|p| p.len())
            .max();
        match matched {
            Some(n) => at += n,
            None => return false,
        }
    }
    at > 0
}

/// The first word of `text` as Whisper wrote it ("Dank" in "Dank u wel.").
pub(crate) fn first_word(text: &str) -> Option<&str> {
    text.split(|c: char| !c.is_alphanumeric())
        .find(|w| !w.is_empty())
}

/// Tokens Whisper may not start its text with, for a decode that has to say something
/// else first. A real "Dank u wel." then still comes out, in lowercase.
pub(crate) struct AvoidStart {
    pub(crate) tokens: Vec<sys::whisper_token>,
    /// Whisper's first timestamp token: decoded tokens at or above it are not text.
    pub(crate) timestamp_begin: sys::whisper_token,
}

/// whisper.cpp's logits filter: while no text token is decoded, rule out `AvoidStart`'s.
///
/// # Safety
/// `user_data` points to an `AvoidStart` that outlives the decode; whisper.cpp passes the
/// tokens decoded so far and the logits of every vocabulary token.
pub(crate) unsafe extern "C" fn avoid_start(
    _ctx: *mut sys::whisper_context,
    _state: *mut sys::whisper_state,
    tokens: *const sys::whisper_token_data,
    n_tokens: c_int,
    logits: *mut f32,
    user_data: *mut c_void,
) {
    let avoid = unsafe { &*(user_data as *const AvoidStart) };
    let decoded = match usize::try_from(n_tokens) {
        Ok(n) if n > 0 && !tokens.is_null() => unsafe { std::slice::from_raw_parts(tokens, n) },
        _ => &[],
    };
    if decoded.iter().all(|t| t.id >= avoid.timestamp_begin) {
        for &id in &avoid.tokens {
            unsafe { *logits.add(id as usize) = f32::NEG_INFINITY };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whole_texts_of_closing_phrases() {
        for text in [
            "Dank u wel.",
            "Dank u wel. Dank u wel.",
            "Thank you very much!",
            "you",
            "Bedankt voor het kijken!",
            "Thanks.",
        ] {
            assert!(only_closing(text), "{text}");
        }
        for text in [
            "Dank u wel voor de vraag.",
            "Thank you, merge it.",
            "Are you there?",
            "",
            "...",
        ] {
            assert!(!only_closing(text), "{text}");
        }
    }

    #[test]
    fn first_words() {
        assert_eq!(first_word("Dank u wel."), Some("Dank"));
        assert_eq!(first_word(" ...you"), Some("you"));
        assert_eq!(first_word("..."), None);
    }
}
