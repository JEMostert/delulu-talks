# Whisper or Parakeet Ultra: test them on your own voice

Delulu Talks offers two speech engines on the **Dictate** page:

- **Whisper** (large-v3-turbo, the default) follows your language setting and reads your vocabulary and the end of your last dictation as a prompt, so names you add are spelled your way.
- **Parakeet Ultra** is three to five times faster and, in a bake-off on public recordings, made fewer errors on spontaneous Dutch (7.3 % against 11.5 % word error rate) and English (5.1 % against 7.3 %), on short clips and on recordings over 30 seconds. It takes no vocabulary, so names rely on cleanup, and it hears the language itself.

Public recordings cannot tell which suits your microphone, room, accent and names. The ten-minute script below can. It is the one the bake-off proposed (spike E1, November 2026).

## The script (about 10 minutes)

Use the microphone you dictate with, in your normal room. For each item, write down what you meant to say; for the free items, type it right after.

1. **Short replies, 2 minutes (16 items, 1–3 s each).** 8 Dutch and 8 English, the way you answer an agent: "Ja, doe maar.", "Nee, laat staan.", "Oké, push hem.", "Yes, merge it.", "Looks good to me.", "Wacht even.", "Stop.", "Try again."
2. **Normal dictation, 3 minutes (12 items, 8–15 s).** 4 Dutch, 4 English and 4 mixed, about what you are working on, with names from your vocabulary: "Kun je in T3 Code de Tauri build fixen, want Cargo geeft een linker error op Wayland."
3. **Mixed with names, 2 minutes (8 items).** Deliberately many names per sentence, in both orders: Dutch with English names, and English with Dutch words.
4. **Long, 2 minutes (2 items, 40–60 s each).** One Dutch, one English, the way you would explain a bug to an agent, pauses included.
5. **Non-speech and switching, 1 minute.**
   - 4 items: hold still for 3 s; breathe; type on the keyboard; click the mouse. Nothing should be typed.
   - The switch test, with smart context on: say an English sentence, then its Dutch version, as two separate dictations. Both should come out in the language you spoke.

## Compare them in the app

1. On the **Dictate** page, pick **Whisper** and dictate the script into a text window. Cleanup can stay on: what gets typed is what matters.
2. Pick **Parakeet** (download Parakeet Ultra if asked; the switch takes effect without a restart) and dictate the same script again.
3. Open **History**. Each entry keeps the typed text and, with cleanup on, the raw transcript (the toggle on the entry). Entries do not show the engine, so the first round is Whisper's and the second Parakeet's. Compare item by item: words wrong or missing, names spelled right, anything typed for the non-speech items, the long items complete, and the switch test in the right language.

## Compare the same recordings (more exact)

Speaking twice never gives the same audio. To feed both engines the very same recording:

```sh
arecord -f S16_LE -r 16000 -c 1 short-01.wav    # one file per item, Ctrl+C to stop
```

Then, with a release engine built (`bun run build:engine`):

```sh
export DELULU_ENGINE=$PWD/target/release/delulu-engine
cargo run --release -p delulu-dictation --example bench -- large-v3-turbo-q5_0 *.wav
cargo run --release -p delulu-dictation --example bench -- parakeet-ultra-q8_0 *.wav
```

Each line shows the file, the language, the time from the end of the audio to the text, and the text. The engines run exactly as the app runs them, without your vocabulary prompt; `DELULU_ALLOWED=nl,en` (the default) is the language set Whisper chooses from.

Keep the recordings private: they hold your voice and your work. Do not commit them.

## When to switch the default

The bake-off's rule: make Parakeet Ultra the default if, on your recordings, its error rate is no worse than Whisper's for Dutch, English and mixed speech each, and the typed text after cleanup gets your names right at least as often.
