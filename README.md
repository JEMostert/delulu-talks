<p align="center">
  <a href="docs/assets/delulu-talks-reel.mp4?raw=true"><img src="docs/assets/delulu-talks-reel.webp" width="100%" alt="The Delulu Talks reel: a pearl in deep water turns coral while Super+Z is held, the words &quot;so um the merch conflict is on monday, no sorry, tuesday&quot; string out as pearls, cleanup pops &quot;um&quot;, lifts the take-back away and fixes merch to merge, and &quot;So the merge conflict is on Tuesday.&quot; lands in a chat window. Vocabulary jars fix &quot;ghthree code&quot; to T3 Code, then the name Delulu Talks appears."></a>
</p>

<p align="center">
  <a href="https://github.com/JEMostert/delulu-talks/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/JEMostert/delulu-talks?style=flat-square&color=0a6a8f&label=release"></a>
  <img alt="Linux" src="https://img.shields.io/badge/Linux-Wayland-5fdcbf?style=flat-square">
  <img alt="Runs locally" src="https://img.shields.io/badge/runs-100%25%20local-c2addb?style=flat-square">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-f6c979?style=flat-square"></a>
</p>

# Delulu Talks

**Hold a key, say it, and it’s typed.** Delulu Talks is push-to-talk dictation for Linux and Apple Silicon Macs. Hold **Super+Z** on Linux or **Control+Shift+Space** on a Mac, speak Dutch or English, let go, and the words land in the app you were using, cleaned up and spelled right. Speech recognition and cleanup both run on your own graphics card. Nothing you say leaves your computer.

<a href="docs/assets/delulu-talks-reel.mp4?raw=true">The reel with sound</a> (MP4, 15 s, 6 MB) ·
[Install](#install) ·
[How it works](#how-it-works) ·
[Delulu FM](#delulu-fm)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/screenshots/dictate-light.png">
    <img src="docs/assets/screenshots/dictate.png" width="100%" alt="The Dictate page: a sidebar with Dictate, Vocabulary, Delulu FM, Voice, Models and Settings; a pearl above the word Ready and “Hold Super Z and talk”; under it every dictation setting on one line each; and on the right the history, one line per dictation with its time, language, topic and how long it took.">
  </picture>
</p>

## What it does

- **Cleans up what you said, not how you said it.** A small local model removes filler words and stutters, drops phrases you took back (“Monday, no sorry, Tuesday”), and adds punctuation. It never rephrases, and if anything goes wrong the raw text is typed instead.
- **Hears what you are talking about.** Cleanup names the topic, such as programming, gaming or finance, and uses it to fix words that were clearly misheard: “merch conflict” becomes “merge conflict” and “nerve it” becomes “nerf it”.
- **Spells your names and terms your way.** On the **Vocabulary** page you keep shelves of names and terms you say often. Put “T3 Code” on a Programming shelf and “ghthree code” comes out as “T3 Code”. Starter shelves for Programming, Gaming & Discord, and Twitch & Streaming are one click away.
- **Remembers the conversation.** The next dictation hands Whisper the topic’s vocabulary and your last sentence (only when you speak the same language again), so names come out right from the start. It is forgotten after 10 quiet minutes, on restart, or with **Clear topic** in the tray menu, and can be turned off on the **Dictate** page.
- **Stays out of your way.** While you talk, a small click-through pearl at the bottom of the screen you are working on strings your voice as a row of pearls. It never takes focus.
- **Keeps a history.** Every transcript is saved in the history on the **Dictate** page before it is typed, with its topic and the raw version behind a **Cleaned up** toggle.

<table>
  <tr>
    <td width="50%"><img src="docs/assets/screenshots/vocabulary.png" alt="The Vocabulary page: the shelves Programming, Gaming &amp; Discord and Twitch &amp; Streaming in a list with their term counts and switches, and the terms of the open shelf beside it."></td>
    <td width="50%"><img src="docs/assets/screenshots/delulu-fm.png" alt="The Delulu FM page: the song on air with its genre and mood, lyrics, the songs up next each with a genre tag, and the mix panel with genre and mood chips, a Shuffle button, a surprise slider and a song length range."></td>
  </tr>
  <tr>
    <td><sub>The <b>Vocabulary</b> page, with the three starter shelves added.</sub></td>
    <td><sub><b>Delulu FM</b>: the song on air, what comes next, and the mix it draws from.</sub></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/assets/screenshots/pill.png" width="100%" alt="The recording pill over a text editor: a coral pearl with a string of pink beads, sending out ripples while it listens."></td>
  </tr>
  <tr>
    <td colspan="2"><sub>The recording pill over a text editor, mid-sentence.</sub></td>
  </tr>
</table>

## Install

### Linux

Download the package for your distribution from the [latest release](https://github.com/JEMostert/delulu-talks/releases/latest): `.pkg.tar.zst` for Arch and CachyOS, `.rpm` for Fedora, or `.deb` for Debian and Ubuntu.

You need a Wayland desktop (GNOME or KDE Plasma) and a Vulkan graphics driver; on GNOME the recording pill also needs XWayland. Setup takes three steps: pick a microphone, allow the shortcut and typing into other apps, and download a speech model: Whisper (574 MB) or Parakeet Ultra (740 MB). The 5.2 GB cleanup model then downloads in the background.

### Apple Silicon Mac

Requires macOS 15 or later and an M-series chip. Open the arm64 DMG, drag **Delulu Talks** to Applications, eject the disk and launch the installed app. This build is ad-hoc signed. Apple has not notarized it, so Gatekeeper can block first launch. Managed Macs may require an administrator. [Apple’s guide to opening downloaded apps](https://support.apple.com/en-us/102445)

Allow Microphone for dictation and Accessibility for pasting into another app. Without Accessibility, use Command+V to paste the copied transcript. Choose a speech model in setup and wait for it to load. In TextEdit, hold Control+Shift+Space, speak and release. The recording pill should disappear, the words should appear at the cursor, and the same transcript should appear in Dictate history. Change the talk key on the Dictate page.

The DMG contains the app, recording pill, model engine and voice CLI. Models and history live outside the bundle in `~/Library/Application Support/delulu-talks`. Quit the app before replacing it to update. If pasting stops after an update, remove Delulu Talks from Accessibility and add the updated app again. To start it at login, add it in System Settings → General → Login Items. For the terminal voice command, run `"/Applications/Delulu Talks.app/Contents/MacOS/delulu" setup`.

## How it works

<p align="center">
  <img src="docs/assets/how-it-works.svg" alt="Hold and speak, Whisper turns speech into text, Gemma cleans it up, and it is typed for you. The topic and vocabulary flow back to Whisper for the next dictation." width="100%">
</p>

- **Whisper** (Large v3 Turbo, whisper.cpp on Vulkan or Metal) turns your speech into text. From letting go of the key to typed text usually takes well under a second.
- **Or Parakeet Ultra** (Moondream's post-trained NVIDIA Parakeet TDT 0.6B v3, through [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp)), the faster engine: three to five times faster than Whisper, it runs on the graphics card or, without one, the processor, and recognizes 25 European languages on its own. It takes no vocabulary, so names rely on cleanup. Pick it during setup or on the **Dictate** page; switching takes effect right away and keeps both downloads. To decide between the two on your own voice, see [docs/speech-engines.md](docs/speech-engines.md). Parakeet v3 from earlier versions is replaced by Parakeet Ultra: the app downloads it once and removes the old files.
- **Cleanup** runs Gemma 4 E4B in a separate helper process, `delulu-engine llm` (llama.cpp with Vulkan or Metal), with the topic and your vocabularies.
- **Typing** pastes the result into the focused app through the desktop’s remote-desktop portal; when that is not allowed, the text is copied and you press Ctrl+V.
- **The recording pill** is its own small program, `delulu-pill` (about 5 MB of memory, no GTK): a layer-shell overlay on KDE Plasma and wlroots desktops, an XWayland window on GNOME. If it cannot draw, the app's built-in GTK pill takes over.

## Delulu FM

An optional radio station made on this computer, hidden until you turn on **Settings → Delulu FM**. Every song is new: the cleanup model writes its title, style and lyrics, [YuE2](https://huggingface.co/m-a-p/YuE2-3B) composes it on your graphics card, and between songs an AI host speaks in the station's language through the native voice (Supertonic 3). The **Delulu FM** page shows what is on air with its lyrics, what comes next and what played, and lets you skip, request a song, and set the mix: you switch genres and moods on once, and every song draws one of each at random, at a random length between 2:00 and 4:30 unless you change the range. A surprise slider lets songs come from outside your picks, Shuffle rolls a new mix, and a mix can be saved as a station. You can like or dislike a song, stay on its genre for a while, or save it.

- **What it needs:** Apple Silicon or a graphics card with a Vulkan driver, the music model and the cleanup model. The music model (YuE2 3B, 4 GB, CC BY-NC 4.0) is an explicit download on the **Models** page, where you can also cancel or delete it; nothing downloads on its own and dictation never needs it. The host is optional; without the voice model (the **Voice** page) the station plays music only.
- **Native:** YuE2 runs in `delulu-engine music`, a helper process shipped with the app that runs the model on ggml with Vulkan or Metal (no Python, no ComfyUI). It loads one part of the model at a time and exits after each song, so its graphics memory is free between songs. See [the parity and performance notes](docs/benchmarks/yue2-native/README.md). A second, faster music engine, ACE-Step 1.5 turbo with MIT weights ([crates/music-ace](crates/music-ace/README.md)), can be chosen on the Delulu FM page.
- **Dictation comes first:** the radio goes quiet while you hold the hotkey, the music engine pauses while you dictate, and no new writing, music or speech starts while you dictate or just after.
- **Buffering:** a short programme is made ahead of playback (two songs or six minutes, at most three items). When nothing new is ready it replays a recent song. Playback is native, so it keeps playing with the window closed.
- **Recovery:** every step is saved. A song stopped half-way (off air, quit) keeps its words and is composed again later. A failed song is retried once, then the station pauses briefly.
- **Storage:** songs, history and settings live in `~/.local/share/delulu-talks/radio`, the music model in `~/.local/share/delulu-talks/models`.

On an RTX 5060 Ti (16 GB), a 2:38 song took 2:47 to make, peaking at 3.7 GB of graphics memory and 1.1 GB of RAM. Generation and playback share the graphics card with dictation; leave room for both or keep the station off.

## Memory and disk

<p align="center">
  <img src="docs/assets/resources.svg" alt="About 0.4 GB of RAM and 4.6 GB of graphics memory with cleanup on; about 0.25 GB of RAM and 0.9 GB of graphics memory with cleanup off." width="100%">
</p>

Both models live on the graphics card. Process monitors such as htop show the cleanup helper (`delulu-engine llm`) at about 3 GB, but most of that is the model file mapped from disk: clean page cache the kernel drops when it needs the memory. Turning cleanup off stops the helper and frees its 3.7 GB of graphics memory.

## Development

On an Apple Silicon Mac, install the Xcode Command Line Tools, CMake, Rust 1.98 or later, and Bun with lockfile v2 support. Run `bun install --frozen-lockfile` then `bun run tauri build --bundles dmg`. The DMG lands in `target/release/bundle/dmg/`.

On Linux you need Rust, Bun, the GTK and WebKitGTK development libraries, ALSA, Vulkan headers, glslc, SPIRV-Headers and clang.

```sh
bun install
bun run build:engine   # delulu-engine: speech to text (Whisper, Parakeet), cleanup (llama.cpp), music (YuE2, ACE-Step) and voice (Supertonic) roles
DELULU_ENGINE=$PWD/target/release/delulu-engine bun run dev
```

The app looks for `delulu-pill` next to its own binary, then in `/usr/lib/delulu-talks`, and otherwise draws the pill with GTK: run `cargo build -p delulu-pill` once to get it in `target/debug/`. `delulu-pill --render listening 0.6 - out.png` draws one frame without a desktop, and `DELULU_PILL=gtk` forces the GTK pill. `tauri dev` does not build the engine and only looks for it next to the debug binary, so point `DELULU_ENGINE` at the release build (or link it into `target/debug/`). The app and the daemon start it once per role (`delulu-engine stt` while dictation is on, `delulu-engine llm`, `delulu-engine music`; `delulu speak` starts `delulu-engine tts`), so a graphics driver crash ends a helper, never the hotkey: a stopped `stt` helper is started again and dictation is back within a few seconds. `delulu-engine probe` prints its version, roles and graphics devices without loading a model. The app and the daemon themselves link no ggml and no ONNX Runtime. All roles share one ggml, the one llama.cpp builds: whisper.cpp builds against it through a patched `whisper-rs-sys`, and the vendored transcribe.cpp the same way ([vendor](vendor/README.md)). That ggml is built with `GGML_MAX_NAME=128` from `.cargo/config.toml`, which the vendored acestep.cpp needs; a build directory from before that setting needs `cargo clean -p llama-cpp-sys-2` once (see [crates/music-ace](crates/music-ace/README.md)). On Fedora, if clang cannot find its headers, set `BINDGEN_EXTRA_CLANG_ARGS` to the GCC include directory.

The log goes to the systemd user journal, so it never holds what you said: each dictation logs its timings, lengths, language, topic and model, but not the text. To debug transcription or cleanup, start the app with `DELULU_LOG_TEXT=1`; the dictation line then also carries the transcript and the raw text, and those stay in the journal after you delete the entry from History.

Checks: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `bun run typecheck`, `bun test ui` and `bun run format:check`. Pushing a `vX.Y.Z` tag builds the packages and publishes the release, with notes from `docs/releases/<tag>.md`.

The reel at the top is made in code: a canvas program draws every frame, a Python synthesizer writes the soundtrack from the same beat map, and `docs/reel/make.sh` rebuilds the MP4 and the WebP. See [docs/reel](docs/reel/README.md).

## License

[MIT](LICENSE). The optional YuE2 music model ([m-a-p/YuE2-3B](https://huggingface.co/m-a-p/YuE2-3B), downloaded in ComfyUI's INT8 packaging from [Comfy-Org/YuE2](https://huggingface.co/Comfy-Org/YuE2)) is CC BY-NC 4.0: non-commercial use only. The optional ACE-Step 1.5 music models ([ACE-Step/Ace-Step1.5](https://huggingface.co/ACE-Step/Ace-Step1.5) by ACE Studio and StepFun, downloaded as [GGUF conversions by Serveurperso](https://huggingface.co/Serveurperso/ACE-Step-1.5-GGUF)) are MIT, their text encoder ([Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)) Apache-2.0; the engine includes [acestep.cpp](https://github.com/ServeurpersoCom/acestep.cpp) (MIT, © The acestep.cpp authors) and yyjson (MIT, © YaoYuan), vendored with their notices in `crates/music-ace/vendor/`. Speech detection uses [Silero VAD](https://github.com/snakers4/silero-vad) v6.2.0 (MIT, Copyright (c) 2020-present Silero Team) as converted for whisper.cpp by [ggml-org](https://huggingface.co/ggml-org/whisper-vad), built into the engine. The Parakeet model is [Parakeet Ultra](https://huggingface.co/moondream/parakeet-ultra) by Moondream, post-trained from [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) (CC BY 4.0), downloaded as the [GGUF conversion by handy-computer](https://huggingface.co/handy-computer/parakeet-ultra-gguf) with its licence and notice of changes; the engine includes [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) (MIT) and its miniz (MIT), vendored with their notices in `vendor/transcribe.cpp/`. The voices are [Supertonic 3](https://huggingface.co/Supertone/supertonic-3) by Supertone Inc. (BigScience OpenRAIL-M, use restrictions apply), downloaded from Supertone's repository on request; the text preprocessing ported from its sample code is MIT, Copyright (c) 2025 Supertone Inc. The reel uses Bricolage Grotesque and Newsreader, the app’s own typefaces, under the SIL Open Font License 1.1; they are downloaded when the reel is built, not stored here. The recording pill embeds a subset of Inter Bold by The Inter Project Authors, under the same licence ([crates/pill/fonts/OFL.txt](crates/pill/fonts/OFL.txt)).

## Spoken agent replies

The Linux packages and the macOS app bundle include `delulu`, a small CLI that lets coding agents speak short replies, and gives Delulu FM its host. It does not start dictation or touch the microphone.

```sh
delulu setup             # installs ~/.local/bin/delulu and the delulu-speak agent skill
delulu install-model     # explicit download: Supertonic 3, about 400 MB
delulu speak 'Done. The fix is ready for review.'
printf '%s' 'De build is geslaagd.' | delulu speak
delulu speak --output /tmp/reply.wav --lang en --voice M2 'Saved, not played.'
```

- **Voice:** [Supertonic 3](https://huggingface.co/Supertone/supertonic-3) by Supertone Inc. runs on the processor in `delulu-engine tts` (ONNX Runtime, no Python, no graphics memory). It speaks Dutch and English, picking the language per sentence (`--lang auto|nl|en`), with ten preset voices (`--voice F1…F5, M1…M5`; the defaults are set on the **Voice** page). Numbers, versions, file names and abbreviations are spelled out first, and a few English developer words inside Dutch get a Dutch respelling; add your own in `~/.local/share/delulu-talks/voice/lexicon-nl.tsv` (`word<TAB>respelling`).
- **Downloads:** only `delulu install-model` or **Install model** in Settings downloads the model, into `~/.local/share/delulu-talks/models/supertonic-3`, after showing its licence. Without it, `speak` fails with installation guidance and exit code 1.
- **Speed:** sentences stream: the first one plays while the next is made. After a reply the engine stays loaded for five minutes (`keepWarmSeconds` in `voice/settings.json`; 0 means a fresh process per reply), so the next reply skips the 1–2 s start-up.
- **Behaviour:** `delulu status` prints readiness as JSON. Replies queue under a per-user lock (a waiting reply gives up after ten minutes). Ctrl-C or SIGTERM stops the reply and returns 130 or 143; failures return 1. Input is capped at 16,000 bytes. `--volume` sets the stream volume (0 is silent) and never the system volume. Playback uses PipeWire's `pw-play`.
- **Chatterbox:** the earlier Chatterbox Turbo voice remains as an opt-in for an existing Python environment: `delulu setup --python /path/to/venv/bin/python`, `delulu install-model --engine chatterbox`, `delulu speak --engine chatterbox …`.

The voices are AI-generated. The model's [OpenRAIL-M licence](https://huggingface.co/Supertone/supertonic-3/blob/3cadd1ee6394adea1bd021217a0e650ede09a323/LICENSE) binds everything they say to its use restrictions, among them: no impersonation and no deception, and say that audio you share is machine generated.

From v1.8.0, open **Settings → About → Check for updates**. Choose **Install update**, approve the system prompt if requested, then quit Delulu Talks from the tray and reopen it. If dictation runs in a separate daemon, restart that daemon too. Settings checks the latest stable GitHub release and verifies a signature bound to its version before installing. Apple Silicon updates replace the installed app bundle (copy it to Applications first). Debian, Fedora and Arch use the installed package format and require a working polkit agent.
