//! Evaluated prompt prefixes for cleanup: the KV state after a prefix's tokens, kept
//! in host memory so a request with the same prefix restores it and decodes only its
//! transcript. Other generations use the KV cache freely in between.

use llama_cpp_2::token::LlamaToken;

/// Two languages, plus room for the previous vocabulary while it is replaced.
pub const CAPACITY: usize = 4;

struct Entry<S> {
    slot: String,
    text: String,
    tokens: Vec<LlamaToken>,
    state: S,
    used: u64,
}

/// At most [`CAPACITY`] prefixes, one per slot; the least recently used goes first.
pub struct PrefixCache<S> {
    entries: Vec<Entry<S>>,
    clock: u64,
}

impl<S> PrefixCache<S> {
    pub fn new() -> Self {
        PrefixCache {
            entries: Vec::new(),
            clock: 0,
        }
    }

    /// The tokens and state cached for exactly this prefix text in `slot`.
    pub fn get(&mut self, slot: &str, text: &str) -> Option<(&[LlamaToken], &S)> {
        self.clock += 1;
        let entry = self
            .entries
            .iter_mut()
            .find(|e| e.slot == slot && e.text == text)?;
        entry.used = self.clock;
        Some((&entry.tokens, &entry.state))
    }

    /// Keep a new prefix. It replaces the slot's previous one (a vocabulary change),
    /// else the least recently used entry once the cache is full.
    pub fn insert(&mut self, slot: &str, text: &str, tokens: Vec<LlamaToken>, state: S) {
        self.clock += 1;
        self.remove(slot);
        if self.entries.len() == CAPACITY {
            let oldest = (0..self.entries.len())
                .min_by_key(|&i| self.entries[i].used)
                .expect("full cache");
            self.entries.swap_remove(oldest);
        }
        self.entries.push(Entry {
            slot: slot.to_string(),
            text: text.to_string(),
            tokens,
            state,
            used: self.clock,
        });
    }

    pub fn remove(&mut self, slot: &str) {
        self.entries.retain(|e| e.slot != slot);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

/// Whether a request can start from the KV state after `prefix`: its tokens must
/// begin with exactly the prefix's tokens (text that merges across the boundary
/// tokenizes differently), and at least one token must follow so the last prompt
/// token's logits exist, unless the request generates nothing.
pub fn reusable(prefix: &[LlamaToken], prompt: &[LlamaToken], max_tokens: u32) -> bool {
    !prefix.is_empty()
        && prompt.starts_with(prefix)
        && (prefix.len() < prompt.len() || max_tokens == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(ids: &[i32]) -> Vec<LlamaToken> {
        ids.iter().copied().map(LlamaToken::new).collect()
    }

    #[test]
    fn a_new_vocabulary_replaces_its_slot() {
        let mut cache = PrefixCache::new();
        cache.insert("en", "en old", tokens(&[1, 2]), "en old state");
        cache.insert("nl", "nl old", tokens(&[1, 3]), "nl old state");
        cache.insert("en", "en new", tokens(&[1, 4]), "en new state");
        assert_eq!(cache.len(), 2);
        assert!(cache.get("en", "en old").is_none());
        assert_eq!(cache.get("en", "en new").unwrap().1, &"en new state");
        assert!(cache.get("nl", "nl old").is_some());
        // The same text under another slot is a different entry.
        assert!(cache.get("nl", "en new").is_none());
    }

    #[test]
    fn the_cache_is_bounded_and_drops_the_least_recently_used() {
        let mut cache = PrefixCache::new();
        for slot in ["a", "b", "c", "d"] {
            cache.insert(slot, slot, tokens(&[1]), ());
        }
        assert!(cache.get("a", "a").is_some());
        cache.insert("e", "e", tokens(&[1]), ());
        assert_eq!(cache.len(), CAPACITY);
        assert!(cache.get("b", "b").is_none(), "b was used least recently");
        for slot in ["a", "c", "d", "e"] {
            assert!(cache.get(slot, slot).is_some(), "{slot}");
        }
    }

    #[test]
    fn only_an_exact_token_prefix_is_reused() {
        let prompt = tokens(&[2, 10, 11, 12, 13]);
        assert!(reusable(&tokens(&[2, 10, 11]), &prompt, 80));
        // The boundary tokenized differently: ":" + " )" vs ":)".
        assert!(!reusable(&tokens(&[2, 10, 14]), &prompt, 80));
        assert!(!reusable(&tokens(&[2, 10, 11, 12, 13, 15]), &prompt, 80));
        assert!(!reusable(&[], &prompt, 80));
        // Nothing after the prefix: no logits to sample from, so only a warm-up.
        assert!(!reusable(&prompt, &prompt, 80));
        assert!(reusable(&prompt, &prompt, 0));
    }
}
