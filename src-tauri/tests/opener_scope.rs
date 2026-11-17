//! The opener's URL scope in `capabilities/default.json`, matched the way
//! tauri-plugin-opener matches it: a URL opens when an `allow` glob matches the
//! raw string and no `deny` glob does.

use serde_json::Value;

fn scope() -> (Vec<glob::Pattern>, Vec<glob::Pattern>) {
    let raw = include_str!("../capabilities/default.json");
    let caps: Value = serde_json::from_str(raw).unwrap();
    let entry = caps["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["identifier"] == "opener:allow-open-url")
        .expect("the opener URL permission");
    let globs = |key: &str| -> Vec<glob::Pattern> {
        entry[key]
            .as_array()
            .map(|list| {
                list.iter()
                    .map(|e| glob::Pattern::new(e["url"].as_str().unwrap()).unwrap())
                    .collect()
            })
            .unwrap_or_default()
    };
    (globs("allow"), globs("deny"))
}

fn allowed(url: &str) -> bool {
    let (allow, deny) = scope();
    allow.iter().any(|p| p.matches(url)) && !deny.iter().any(|p| p.matches(url))
}

#[test]
fn every_page_the_app_links_to_opens() {
    // The licence tags on the Models page, the Licences dialog in Settings and
    // the project page link.
    for url in [
        "https://github.com/JEMostert/delulu-talks",
        "https://github.com/JEMostert/delulu-talks/blob/master/LICENSE",
        "https://github.com/openai/whisper/blob/main/LICENSE",
        "https://github.com/snakers4/silero-vad",
        "https://huggingface.co/handy-computer/parakeet-ultra-gguf/blob/a1539be1b849ea7463b88343e5277b373d0c4ea9/LICENSE",
        "https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf",
        "https://huggingface.co/Supertone/supertonic-3/blob/3cadd1ee6394adea1bd021217a0e650ede09a323/LICENSE",
        "https://huggingface.co/m-a-p/YuE2-3B",
        "https://huggingface.co/Serveurperso/ACE-Step-1.5-GGUF",
        "https://huggingface.co/Serveurperso/ACE-Step-1.5-GGUF/blob/666ac70204440867d8c01ba4b119cc79c95b370a/LICENSE",
        "https://creativecommons.org/licenses/by/4.0/",
        "https://creativecommons.org/licenses/by-nc/4.0/",
        "https://ai.google.dev/gemma/docs/gemma_4_license",
    ] {
        assert!(allowed(url), "{url} should open");
    }
}

#[test]
fn lookalike_and_escaping_urls_stay_closed() {
    for url in [
        // A repository whose name only starts with an allowed one.
        "https://github.com/snakers4/silero-vad-malicious",
        "https://github.com/JEMostert/delulu-talks-evil/releases",
        "https://huggingface.co/m-a-p/YuE2-3B-evil",
        "https://ai.google.dev/gemma/docs/gemma_4_license-evil",
        // Other pages on an allowed host.
        "https://huggingface.co/someone/model",
        "https://github.com/openai/whisper-evil",
        // Dot segments that a browser resolves out of the allowed repository.
        "https://github.com/openai/whisper/../../evil/repo",
        "https://github.com/openai/whisper/%2e%2e/%2E%2E/evil/repo",
        "https://github.com/openai/whisper/..\\..\\evil/repo",
        "https://github.com/openai/whisper/%5c..%5Cevil",
        // Another scheme or host.
        "http://github.com/openai/whisper",
        "https://github.com.evil.example/openai/whisper",
        "file:///etc/passwd",
    ] {
        assert!(!allowed(url), "{url} should not open");
    }
}
