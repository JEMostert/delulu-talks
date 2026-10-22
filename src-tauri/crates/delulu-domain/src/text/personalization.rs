//! Vocabulary corrections and text shortcuts (`src/personalization.ts`).
//!
//! Triggers match whole phrases case-insensitively with Unicode simple case
//! folding, longest first, in one pass that never cascades replacements.
//! Technical literals (addresses, paths, inline code, commands) stay exact.

use std::collections::{BTreeMap, HashSet};
use std::sync::LazyLock;

use regex::{Regex, RegexBuilder};
use regex_syntax::hir::{ClassUnicode, ClassUnicodeRange};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::catalog::LANGUAGES;
use crate::js;
use crate::types::{CustomWord, RuleKind};

use super::technical_identifiers::{split_technical_text, technical_ranges};
use super::TextPart;

static LANGUAGE_SEPARATOR: LazyLock<Regex> = LazyLock::new(|| js::regex("[-_]", ""));
static WORD_CHARACTER: LazyLock<Regex> = LazyLock::new(|| js::regex(r"[\p{L}\p{M}\p{N}_]", "u"));

/// A language name or code, reduced to the primary code: "English" and
/// "en-US" are both "en"; empty means global.
pub fn normalize_rule_language(language: Option<&str>) -> String {
    let value = js::trim(language.unwrap_or("")).to_lowercase();
    match LANGUAGES.iter().find(|(_, name)| name.to_lowercase() == value) {
        Some((code, _)) => (*code).to_owned(),
        None => LANGUAGE_SEPARATOR.split(&value).next().unwrap_or("").to_owned(),
    }
}

pub fn rule_language(rule: &CustomWord) -> String {
    normalize_rule_language(rule.language.as_deref())
}

pub fn rule_applies_to_language(rule: &CustomWord, language: Option<&str>) -> bool {
    let scope = rule_language(rule);
    scope.is_empty() || scope == normalize_rule_language(language)
}

pub fn rule_kind(rule: &CustomWord) -> RuleKind {
    rule.kind.unwrap_or(if rule.replacement.is_empty() { RuleKind::Correction } else { RuleKind::Shortcut })
}

pub const MAX_RULE_ALIASES: usize = 32;
pub const MAX_ALIAS_LENGTH: usize = 256;

/// Bound persisted aliases without interpreting commas as separators.
pub fn normalize_aliases<S: AsRef<str>>(aliases: &[S]) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for item in aliases {
        let phrase = js::truncate_utf16(js::trim(item.as_ref()), MAX_ALIAS_LENGTH);
        if phrase.is_empty() || phrase.contains(['\r', '\n']) {
            continue;
        }
        if !result.iter().any(|alias| same_phrase(alias, phrase)) {
            result.push(phrase.to_owned());
        }
        if result.len() == MAX_RULE_ALIASES {
            break;
        }
    }
    result
}

/// [`normalize_aliases`] for an unvalidated JSON value; non-text items are skipped.
pub fn normalize_aliases_value(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => normalize_aliases(&items.iter().filter_map(Value::as_str).collect::<Vec<_>>()),
        _ => Vec::new(),
    }
}

pub fn alias_error(aliases: &[String]) -> Option<String> {
    let phrases: Vec<&str> = aliases.iter().map(|alias| js::trim(alias)).filter(|alias| !alias.is_empty()).collect();
    if phrases.len() > MAX_RULE_ALIASES {
        return Some(format!("Use at most {MAX_RULE_ALIASES} aliases per rule."));
    }
    if phrases.iter().any(|phrase| js::utf16_len(phrase) > MAX_ALIAS_LENGTH) {
        return Some(format!("Each alias must be {MAX_ALIAS_LENGTH} characters or fewer."));
    }
    if phrases.iter().any(|phrase| phrase.contains(['\r', '\n'])) {
        return Some("Use one alias per line.".into());
    }
    None
}

/// Spoken phrases that trigger a rule, deduplicated in order: legacy
/// comma-separated `soundsLike`, aliases, and a shortcut's own term.
pub fn rule_triggers(rule: &CustomWord) -> Vec<String> {
    let mut triggers: Vec<String> = Vec::new();
    let mut push = |trigger: &str| {
        if !trigger.is_empty() && !triggers.iter().any(|existing| existing == trigger) {
            triggers.push(trigger.to_owned());
        }
    };
    for word in rule.sounds_like.split(',') {
        push(js::trim(word));
    }
    for alias in normalize_aliases(rule.aliases.as_deref().unwrap_or_default()) {
        push(&alias);
    }
    if rule_kind(rule) == RuleKind::Shortcut {
        push(js::trim(&rule.term));
    }
    triggers
}

fn folds_to(a: char, b: char) -> bool {
    if a == b {
        return true;
    }
    let mut class = ClassUnicode::new([ClassUnicodeRange::new(a, a)]);
    class.case_fold_simple();
    class.ranges().iter().any(|range| range.start() <= b && b <= range.end())
}

/// Whether two phrases are equal under Unicode simple case folding, like
/// `/^(?:phrase)$/iu.test(other)`.
pub fn same_phrase(phrase: &str, other: &str) -> bool {
    phrase.chars().count() == other.chars().count() && phrase.chars().zip(other.chars()).all(|(a, b)| folds_to(a, b))
}

struct PhraseMatch<'r, T> {
    start: usize,
    end: usize,
    trigger: &'r str,
    output: &'r T,
}

/// Whole-phrase matches of the rule triggers, longest phrase first. Word
/// characters and apostrophes inside a word (`dell ulu's`) are not phrase
/// boundaries. Offsets are bytes.
fn phrase_matches<'r, T>(text: &str, rules: &'r [(String, T)]) -> Vec<PhraseMatch<'r, T>> {
    if rules.is_empty() {
        return Vec::new();
    }
    // Stable sort by UTF-16 length, like Array.prototype.sort in V8.
    let mut order: Vec<usize> = (0..rules.len()).collect();
    order.sort_by_key(|&index| std::cmp::Reverse(js::utf16_len(&rules[index].0)));
    let alternatives: Vec<String> = order.iter().map(|&index| format!("({})", regex::escape(&rules[index].0))).collect();
    // The lookahead `(?!W)(?!['’]W)` is consumed after the logical match `m`.
    let pattern = format!(
        r"(?P<m>{})(?:$|[^\p{{L}}\p{{M}}\p{{N}}_'’]|['’](?:$|[^\p{{L}}\p{{M}}\p{{N}}_]))",
        alternatives.join("|")
    );
    let regex = RegexBuilder::new(&pattern)
        .case_insensitive(true)
        .size_limit(1 << 30)
        .dfa_size_limit(64 << 20)
        .build()
        .expect("escaped phrases form a valid pattern");
    let is_word = |ch: Option<char>| js::char_matches(&WORD_CHARACTER, ch);
    let found = js::scan(&regex, text, |caps| {
        // The lookbehind `(?<!W)(?<!W['’])`.
        let start = js::logical(caps).start();
        let before = js::char_before(text, start);
        if is_word(before) {
            return false;
        }
        match before {
            Some(apostrophe @ ('\'' | '’')) => !is_word(js::char_before(text, start - apostrophe.len_utf8())),
            _ => true,
        }
    });
    found
        .iter()
        .map(|caps| {
            let span = js::logical(caps);
            let selected = caps.iter().skip(2).position(|group| group.is_some()).expect("one phrase matched");
            let (trigger, output) = &rules[order[selected]];
            PhraseMatch { start: span.start(), end: span.end(), trigger, output }
        })
        .collect()
}

fn replace_phrases(text: &str, rules: &[(String, String)]) -> String {
    if rules.is_empty() {
        return text.to_owned();
    }
    let mut cursor = 0;
    let mut result = String::with_capacity(text.len());
    for found in phrase_matches(text, rules) {
        result.push_str(&text[cursor..found.start]);
        result.push_str(found.output);
        cursor = found.end;
    }
    result.push_str(&text[cursor..]);
    result
}

/// The message for a rule whose trigger another rule already uses, or `None`.
pub fn rule_conflict(draft: &CustomWord, words: &[CustomWord]) -> Option<String> {
    let triggers = rule_triggers(draft);
    if triggers.is_empty() {
        return None;
    }
    let draft_language = rule_language(draft);
    for word in words {
        let language = rule_language(word);
        if word.id == draft.id || (!language.is_empty() && !draft_language.is_empty() && language != draft_language) {
            continue;
        }
        let Some(existing_trigger) =
            rule_triggers(word).into_iter().find(|trigger| triggers.iter().any(|own| same_phrase(own, trigger)))
        else {
            continue;
        };
        // Keep both saved spellings: Unicode simple folding can match phrases
        // whose characters differ, such as “ſ” and “s”.
        let draft_trigger = triggers.iter().find(|trigger| same_phrase(trigger, &existing_trigger))?;
        let draft_kind = if rule_kind(draft) == RuleKind::Shortcut { "Text shortcut" } else { "Correction" };
        let existing_kind = if rule_kind(word) == RuleKind::Shortcut { "text shortcut" } else { "correction" };
        return Some(format!(
            "{draft_kind} trigger “{draft_trigger}” is already used by {existing_kind} “{}” (trigger “{existing_trigger}”{}). Edit that rule or choose another phrase.",
            word.term,
            if word.enabled { "" } else { ", disabled" }
        ));
    }
    None
}

fn enabled_rules<'w>(words: &'w [CustomWord], language: Option<&str>) -> Vec<(String, &'w str, &'w CustomWord)> {
    let mut rules = Vec::new();
    for word in words {
        if !word.enabled || !rule_applies_to_language(word, language) {
            continue;
        }
        let output = if rule_kind(word) == RuleKind::Shortcut { &word.replacement } else { &word.term };
        if js::trim(output).is_empty() {
            continue;
        }
        for trigger in rule_triggers(word) {
            rules.push((trigger, output.as_str(), word));
        }
    }
    rules
}

/// Applies enabled rules for `language` (rules without a language always
/// apply) outside technical literals.
pub fn personalize(text: &str, words: &[CustomWord], language: Option<&str>) -> String {
    let mut seen = HashSet::new();
    let mut rules: Vec<(String, String)> = Vec::new();
    for (trigger, output, _) in enabled_rules(words, language) {
        // Stable first-rule priority for legacy conflicts. Never cascade replacements.
        if seen.insert(trigger.clone()) {
            rules.push((trigger, output.to_owned()));
        }
    }
    split_technical_text(text)
        .into_iter()
        .map(|part| if part.protected { part.text } else { replace_phrases(&part.text, &rules) })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleMatch {
    pub rule_id: String,
    pub term: String,
    pub kind: RuleKind,
    pub trigger: String,
    pub matched_text: String,
    pub replacement: String,
    /// UTF-16 offset in the original text, like the TypeScript.
    pub index: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalizationPreview {
    pub original: String,
    pub result: String,
    pub matches: Vec<RuleMatch>,
}

/// Explain the same matching pass used for clean output; never save or cascade.
pub fn preview_personalization(text: &str, words: &[CustomWord], language: Option<&str>) -> PersonalizationPreview {
    let mut seen = HashSet::new();
    let mut rules: Vec<(String, (&str, &CustomWord))> = Vec::new();
    for (trigger, output, rule) in enabled_rules(words, language) {
        if seen.insert(trigger.clone()) {
            rules.push((trigger, (output, rule)));
        }
    }
    let literals = technical_ranges(text);
    let mut literal_index = 0;
    let mut matches = Vec::new();
    let mut result = String::with_capacity(text.len());
    let mut cursor = 0;
    for found in phrase_matches(text, &rules) {
        while literal_index < literals.len() && literals[literal_index].end <= found.start {
            literal_index += 1;
        }
        if literal_index < literals.len() && literals[literal_index].start < found.end {
            continue;
        }
        let (output, rule) = *found.output;
        result.push_str(&text[cursor..found.start]);
        result.push_str(output);
        cursor = found.end;
        matches.push(RuleMatch {
            rule_id: rule.id.clone(),
            term: rule.term.clone(),
            kind: rule_kind(rule),
            trigger: found.trigger.to_owned(),
            matched_text: text[found.start..found.end].to_owned(),
            replacement: output.to_owned(),
            index: js::byte_to_utf16(text, found.start),
        });
    }
    result.push_str(&text[cursor..]);
    PersonalizationPreview { original: text.to_owned(), result, matches }
}

/// Keep saved blocks and technical literals outside the language model.
pub fn split_for_rewrite(text: &str, words: &[CustomWord], language: Option<&str>) -> Vec<TextPart> {
    let mut rules: Vec<(String, String)> = Vec::new();
    let mut seen = HashSet::new();
    let mut saved_blocks: HashSet<&str> = HashSet::new();
    for word in words {
        if !word.enabled || rule_kind(word) != RuleKind::Shortcut || js::trim(&word.replacement).is_empty() {
            continue;
        }
        saved_blocks.insert(&word.replacement);
        // Already saved exact blocks stay protected even when rewriting an older language.
        let triggers = if rule_applies_to_language(word, language) { rule_triggers(word) } else { Vec::new() };
        for phrase in std::iter::once(word.replacement.clone()).chain(triggers) {
            if seen.insert(phrase.clone()) {
                rules.push((phrase, word.replacement.clone()));
            }
        }
    }
    if rules.is_empty() {
        return split_technical_text(text);
    }
    let mut parts = Vec::new();
    let literals = technical_ranges(text);
    let mut literal_index = 0;
    let mut cursor = 0;
    for found in phrase_matches(text, &rules) {
        let matched_text = &text[found.start..found.end];
        while literal_index < literals.len() && literals[literal_index].end <= found.start {
            literal_index += 1;
        }
        // Exact saved blocks take priority. A spoken-trigger alias inside an
        // address, path, command or version must never alter that literal.
        if !saved_blocks.contains(matched_text)
            && literal_index < literals.len()
            && literals[literal_index].start < found.end
        {
            continue;
        }
        if found.start > cursor {
            parts.push(TextPart::new(&text[cursor..found.start], false));
        }
        // Triggers use case-insensitive recognition, but an already expanded block
        // must retain its bytes even when another block differs only in case.
        let protected = if saved_blocks.contains(matched_text) { matched_text } else { found.output.as_str() };
        parts.push(TextPart::new(protected, true));
        cursor = found.end;
    }
    if cursor < text.len() {
        parts.push(TextPart::new(&text[cursor..], false));
    }
    parts.into_iter().flat_map(|part| if part.protected { vec![part] } else { split_technical_text(&part.text) }).collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersonalizationUsage {
    pub text: String,
    /// Matches per rule id.
    pub counts: BTreeMap<String, u64>,
}

/// Count selected source matches without retaining transcript text.
pub fn personalize_with_usage(text: &str, words: &[CustomWord], language: Option<&str>) -> PersonalizationUsage {
    let preview = preview_personalization(text, words, language);
    let mut counts = BTreeMap::new();
    for found in &preview.matches {
        *counts.entry(found.rule_id.clone()).or_insert(0) += 1;
    }
    PersonalizationUsage { text: preview.result, counts }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::WordPackId;
    use crate::word_packs::active_rules;

    pub(crate) fn rule(id: &str, term: &str, sounds_like: &str) -> CustomWord {
        CustomWord {
            id: id.into(),
            term: term.into(),
            sounds_like: sounds_like.into(),
            enabled: true,
            ..CustomWord::default()
        }
    }

    fn scoped(mut word: CustomWord, language: &str) -> CustomWord {
        word.language = Some(language.into());
        word
    }

    #[test]
    fn uses_longest_source_matches_once_respects_language_and_boundaries_and_explains_usage() {
        let mut disabled = rule("disabled", "Wrong", "please");
        disabled.enabled = false;
        let words = vec![
            scoped(rule("phrase", "Delulu Talks", "dell ulu talks"), "en"),
            rule("word", "Delulu", "dell ulu"),
            rule("no-cascade", "Wrong", "Delulu Talks"),
            scoped(rule("other-language", "Wrong", "send"), "nl"),
            disabled,
        ];
        let source = "Please send DELL ULU TALKS and dell ulu; xdell ulu and dell ulu's stay.";
        let result = "Please send Delulu Talks and Delulu; xdell ulu and dell ulu's stay.";
        assert_eq!(personalize(source, &words, Some("en-US")), result);
        let usage = personalize_with_usage(source, &words, Some("English"));
        assert_eq!(usage.text, result);
        assert_eq!(usage.counts, BTreeMap::from([("phrase".into(), 1), ("word".into(), 1)]));
        let preview = preview_personalization(source, &words, Some("en"));
        let spans: Vec<&str> = preview.matches.iter().map(|m| m.matched_text.as_str()).collect();
        assert_eq!(spans, ["DELL ULU TALKS", "dell ulu"]);
        assert_eq!(preview.matches[0].index, 12);
    }

    #[test]
    fn leaves_addresses_paths_inline_code_and_commands_exact() {
        let words = vec![rule("name", "DELULU", "delulu")];
        let source = "delulu https://delulu.dev/a delulu /tmp/delulu/file\n`delulu` delulu\nbun run delulu\ndelulu";
        let expected = "DELULU https://delulu.dev/a DELULU /tmp/delulu/file\n`delulu` DELULU\nbun run delulu\nDELULU";
        assert_eq!(personalize(source, &words, None), expected);
        let usage = personalize_with_usage(source, &words, None);
        assert_eq!(usage.text, expected);
        assert_eq!(usage.counts, BTreeMap::from([("name".into(), 4)]));
    }

    #[test]
    fn keeps_exact_multiline_shortcut_blocks_outside_rewriting() {
        let block = "Dear team,\r\n\tKeep THIS spacing.\r\nRegards, Boran";
        let mut signature = scoped(rule("signature", "sign off", "my signature"), "en");
        signature.kind = Some(RuleKind::Shortcut);
        signature.replacement = block.into();
        let words = vec![signature];
        let parts = split_for_rewrite(&format!("Polish this. my signature\nhttps://site.dev/my signature\n{block}"), &words, Some("en"));
        let joined: String = parts.iter().map(|part| part.text.as_str()).collect();
        assert_eq!(joined, format!("Polish this. {block}\nhttps://site.dev/my signature\n{block}"));
        let protected: Vec<&str> = parts.iter().filter(|part| part.protected).map(|part| part.text.as_str()).collect();
        assert_eq!(protected, [block, "https://site.dev/my", block]);
        assert_eq!(
            split_for_rewrite(&format!("my signature\n{block}"), &words, Some("nl")),
            [TextPart::new("my signature\n", false), TextPart::new(block, true)]
        );
    }

    #[test]
    fn pack_words_fix_known_misspellings_and_own_rules_win() {
        let packs = active_rules(&[], &[WordPackId::Programming]);
        assert_eq!(personalize("push it to git hub, then cube control apply", &packs, None), "push it to GitHub, then kubectl apply");
        let own = active_rules(&[rule("own", "Git Hub Enterprise", "git hub")], &[WordPackId::Programming]);
        assert_eq!(personalize("open git hub", &own, None), "open Git Hub Enterprise");
        assert_eq!(personalize("open git hub", &active_rules(&[], &[]), None), "open git hub");
        let gaming = active_rules(&[], &[WordPackId::Gaming]);
        assert_eq!(personalize("g g, ik ben a f k in CS two", &gaming, Some("nl")), "GG, ik ben AFK in CS2");
    }

    #[test]
    fn conflicts_and_aliases_use_unicode_simple_folding() {
        let existing = rule("a", "Kestrel", "ſtar");
        let draft = rule("b", "Other", "STAR");
        let message = rule_conflict(&draft, &[existing]).unwrap();
        assert_eq!(
            message,
            "Correction trigger “STAR” is already used by correction “Kestrel” (trigger “ſtar”). Edit that rule or choose another phrase."
        );
        assert_eq!(normalize_aliases(&[" A ", "a", "b\nc", ""]), ["A"]);
        assert_eq!(normalize_rule_language(Some(" Dutch ")), "nl");
        assert_eq!(normalize_rule_language(Some("pt_BR")), "pt");
    }
}
