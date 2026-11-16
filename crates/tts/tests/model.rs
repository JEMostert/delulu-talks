//! Runs the real model when it is on disk: `DELULU_TTS_MODEL_DIR=<supertonic-3 folder>
//! cargo test -p delulu-tts --features onnx --release -- --ignored`.
#![cfg(feature = "onnx")]
use delulu_tts::{trim, Lang, LangChoice, Lexicon, SynthOptions, Synthesizer, SENTENCE_PAUSE_MS};
use std::cell::Cell;

fn synthesizer() -> Synthesizer {
    let dir = std::env::var_os("DELULU_TTS_MODEL_DIR").expect("set DELULU_TTS_MODEL_DIR");
    Synthesizer::load(dir.as_ref(), 4, Lexicon::builtin()).expect("load")
}

#[test]
#[ignore = "needs the Supertonic 3 model"]
fn sentences_stream_one_by_one_with_pauses_in_range() {
    let mut synth = synthesizer();
    let rate = synth.sample_rate();
    let mut chunks: Vec<Vec<f32>> = Vec::new();
    let opts = SynthOptions {
        lang: LangChoice::Fixed(Lang::En),
        ..Default::default()
    };
    let spoken = synth
        .speak(
            "I looked into the crash you reported this morning. It happened because the settings file was read too early.",
            &opts,
            &|| false,
            &mut |audio| {
                chunks.push(audio.to_vec());
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(chunks.len(), 2);
    assert_eq!(spoken.segments, 2);
    let all: Vec<f32> = chunks.concat();
    // Edges trimmed: speech starts within 60 ms.
    let (start, end) = trim::speech_bounds(&all, rate);
    assert!(
        start * 1000 / rate as usize <= 60,
        "lead-in {} ms",
        start * 1000 / rate as usize
    );
    assert!((all.len() - end) * 1000 / rate as usize <= 60);
    // The gap between the sentences: the pause plus the kept margins, give or take a
    // short stop inside the speech itself.
    let gap = trim::longest_inner_gap_ms(&all, rate);
    assert!(
        (SENTENCE_PAUSE_MS..=SENTENCE_PAUSE_MS + 250).contains(&gap),
        "gap {gap} ms"
    );
}

#[test]
#[ignore = "needs the Supertonic 3 model"]
fn cancel_stops_between_denoising_steps() {
    let mut synth = synthesizer();
    let calls = Cell::new(0);
    let result = synth.speak(
        "Dit is een lange zin die nooit helemaal uitgesproken wordt omdat hij halverwege wordt afgebroken.",
        &SynthOptions::default(),
        &|| {
            calls.set(calls.get() + 1);
            calls.get() > 3
        },
        &mut |_| Ok(()),
    );
    assert!(
        matches!(result, Err(delulu_tts::Error::Cancelled)),
        "{result:?}"
    );
}
