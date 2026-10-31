//! Write songs with the real Gemma model and print them, to judge the writer prompts
//! without ComfyUI. `cargo run -p delulu-radio --example songwriter -- [case] [seeds]`
//!
//! Uses the cleanup helper when `DELULU_CLEANUP_HELPER` is set (model from
//! `DELULU_CLEANUP_MODEL` or the app's models dir); otherwise a llama-server
//! serving the same Gemma GGUF at `LLAMA_URL` (default http://127.0.0.1:18431,
//! e.g. `llama-server -m gemma-4-E4B_q4_0-it.gguf -c 6144 -np 1 -ngl 99 --port 18431`),
//! with the helper's sampler chain. `SONGWRITER_RAW=1` also prints the raw replies.
use delulu_cleanup::{Cleaner, Sampling};
use delulu_radio::model::{Direction, Energy, Length, Vocals};
use delulu_radio::writer::{self, Recent};
use std::path::PathBuf;
use std::time::{Duration, Instant};

enum Writer {
    Helper(Cleaner),
    Server(String),
}

impl Writer {
    fn write(&mut self, prompt: &str, max_tokens: u32, seed: u32) -> (String, bool) {
        match self {
            Writer::Helper(cleaner) => {
                let sampling = Sampling {
                    seed,
                    temperature: 0.9,
                    top_p: 0.95,
                };
                let out = cleaner
                    .generate(
                        prompt.into(),
                        max_tokens,
                        Some(sampling),
                        Duration::from_secs(180),
                    )
                    .expect("helper");
                (out.text, out.truncated)
            }
            Writer::Server(url) => {
                let body = serde_json::json!({
                    "prompt": prompt,
                    "n_predict": max_tokens,
                    "seed": seed,
                    "temperature": 0.9,
                    "top_p": 0.95,
                    "top_k": 0,
                    "min_p": 0.0,
                    "repeat_penalty": 1.1,
                    "repeat_last_n": 64,
                    "samplers": ["penalties", "top_p", "temperature"],
                    "cache_prompt": false,
                });
                let mut response = ureq::post(&format!("{url}/completion"))
                    .header("Content-Type", "application/json")
                    .send(body.to_string())
                    .expect("llama-server");
                let v: serde_json::Value =
                    serde_json::from_str(&response.body_mut().read_to_string().expect("reply"))
                        .expect("json");
                (
                    v["content"].as_str().unwrap_or_default().to_string(),
                    v["stop_type"].as_str() == Some("limit"),
                )
            }
        }
    }
}

fn cases() -> Vec<(&'static str, Direction, Option<&'static str>)> {
    let base = Direction::default();
    let d = |mood: &str, genres: &[&str], energy, vocals, length, theme: &str| Direction {
        mood: mood.into(),
        genres: genres.iter().map(|g| g.to_string()).collect(),
        energy,
        vocals,
        length,
        theme: theme.into(),
        ..base.clone()
    };
    vec![
        (
            "rap",
            d(
                "defiant",
                &["hip hop", "boom bap"],
                Energy::High,
                Vocals::Vocal,
                Length::Medium,
                "",
            ),
            None,
        ),
        (
            "dancepop",
            d(
                "euphoric",
                &["dance pop", "house"],
                Energy::High,
                Vocals::Vocal,
                Length::Short,
                "",
            ),
            None,
        ),
        (
            "ballad",
            d(
                "tender",
                &["acoustic ballad", "folk"],
                Energy::Low,
                Vocals::Vocal,
                Length::Medium,
                "",
            ),
            None,
        ),
        (
            "ambient",
            d(
                "calm",
                &["ambient", "modern classical"],
                Energy::Low,
                Vocals::Instrumental,
                Length::Long,
                "",
            ),
            None,
        ),
        (
            "request",
            Direction::default(),
            Some("a song for my sister who just moved to another country"),
        ),
        (
            "jrock",
            d(
                "bittersweet",
                &["J-rock", "anime opening"],
                Energy::High,
                Vocals::Vocal,
                Length::Medium,
                "",
            ),
            None,
        ),
        (
            "dutch",
            Direction {
                language: "Dutch".into(),
                ..d(
                    "nostalgic",
                    &["indie pop"],
                    Energy::Medium,
                    Vocals::Vocal,
                    Length::Short,
                    "cycling home along the canal",
                )
            },
            None,
        ),
        ("default", Direction::default(), None),
    ]
}

fn main() {
    let mut args = std::env::args().skip(1);
    let only = args.next().filter(|a| a != "all");
    let seeds: u64 = args.next().map_or(1, |s| s.parse().expect("seeds"));
    let mut writer = match std::env::var_os("DELULU_CLEANUP_HELPER") {
        Some(helper) => {
            let model = std::env::var_os("DELULU_CLEANUP_MODEL")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    let home = PathBuf::from(std::env::var_os("HOME").expect("HOME"));
                    home.join(".local/share/delulu-talks/models")
                        .join(delulu_cleanup::MODEL_FILE)
                });
            let cleaner = Cleaner::start(
                &PathBuf::from(helper),
                &model,
                Duration::from_secs(180),
                |_| {},
            )
            .expect("helper");
            Writer::Helper(cleaner)
        }
        None => Writer::Server(
            std::env::var("LLAMA_URL").unwrap_or_else(|_| "http://127.0.0.1:18431".into()),
        ),
    };
    for (name, direction, request) in cases() {
        if only.as_deref().is_some_and(|o| o != name) {
            continue;
        }
        for i in 0..seeds {
            let seed = 1_000_003 * (i + 1) + name.len() as u64;
            let instrumental = writer::instrumental(&direction, seed);
            let (prompt, tokens) =
                writer::song_prompt(&direction, instrumental, request, &Recent::default(), seed);
            let started = Instant::now();
            let (reply, truncated) = writer.write(&prompt, tokens, seed as u32);
            println!(
                "===== {name} seed {seed} ({} ms, truncated {truncated})",
                started.elapsed().as_millis()
            );
            if std::env::var_os("SONGWRITER_RAW").is_some() {
                println!("--- raw ---\nTitle:{reply}\n--- parsed ---");
            }
            match writer::parse_song(&reply, &direction, instrumental) {
                Ok(draft) => {
                    println!("TITLE: {}\nSTYLE: {}", draft.title, draft.style);
                    println!("{}", writer::conditioning_lyrics(&draft));
                }
                Err(e) => println!("REJECTED: {e}\n--- raw reply ---\nTitle:{reply}"),
            }
        }
    }
}
