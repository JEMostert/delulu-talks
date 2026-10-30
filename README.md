<p align="center">
  <img src="docs/assets/header.svg" alt="Delulu Talks: hold a key, say it, and it’s typed." width="100%">
</p>

<p align="center">
  <a href="https://github.com/JEMostert/delulu-talks/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/JEMostert/delulu-talks?style=flat-square&color=0a6a8f&label=release"></a>
  <img alt="Linux" src="https://img.shields.io/badge/Linux-Wayland-5fdcbf?style=flat-square">
  <img alt="Runs locally" src="https://img.shields.io/badge/runs-100%25%20local-c2addb?style=flat-square">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-f6c979?style=flat-square"></a>
</p>

Delulu Talks is push-to-talk dictation for Linux. Hold **Super+Z**, speak Dutch or English, let go, and the words are typed into the app you were using, cleaned up and spelled right. Speech recognition and cleanup both run on your own graphics card. Nothing you say leaves your computer.

## How it works

<p align="center">
  <img src="docs/assets/how-it-works.svg" alt="Hold and speak, Whisper turns speech into text, Gemma cleans it up, and it is typed for you. The topic and vocabulary flow back to Whisper for the next dictation." width="100%">
</p>

- **Whisper** (Large v3 Turbo, whisper.cpp on Vulkan) turns your speech into text. From letting go of the key to typed text usually takes well under a second.
- **Or Parakeet** (NVIDIA Parakeet TDT 0.6B v3 on ONNX Runtime), the faster engine: it runs on the processor, recognizes 25 European languages on its own and needs no graphics memory. Pick it during setup or in **Settings → Dictation**; switching back and forth keeps both downloads.
- **Cleanup** with Gemma 4 E4B removes filler words and stutters, drops phrases you took back ("Monday, no sorry, Tuesday"), and adds punctuation. It never rephrases, and if anything goes wrong the raw text is typed instead.
- **Topics:** cleanup names what you are talking about, such as programming, gaming or finance, and uses it to fix words that were clearly misheard: "merch conflict" becomes "merge conflict" and "nerve it" becomes "nerf it".
- **Vocabularies:** on the **Cleanup** page you keep shelves of names and terms you say often, shown as glass jars on a reef. Put "T3 Code" on a Programming shelf and "ghthree code" comes out as "T3 Code". Starter shelves for Programming, Gaming & Discord, and Twitch & Streaming are one click away.
- **Smart context management:** the next dictation hands Whisper the topic's vocabulary and your last sentence, so names come out right from the start. It is forgotten after 10 quiet minutes, on restart, or with **Clear topic** in the tray menu, and can be turned off in **Settings → Dictation**.
- **The recording pill:** while you talk, a small click-through pearl at the bottom of the screen you are working on strings your voice as a row of pearls. It never takes focus.

Every transcript is saved in **History** before it is typed, with its topic and the raw version behind a **Cleaned up** toggle.

## Install

Download the package for your distribution from the [latest release](https://github.com/JEMostert/delulu-talks/releases/latest): `.pkg.tar.zst` for Arch and CachyOS, `.rpm` for Fedora, or `.deb` for Debian and Ubuntu.

You need a Wayland desktop (GNOME or KDE Plasma), a Vulkan graphics driver, and XWayland for the recording pill. Setup takes three steps: pick a microphone, allow the shortcut and typing into other apps, and download a speech model: Whisper (574 MB) or Parakeet (671 MB). The 5.2 GB cleanup model then downloads in the background.

## Delulu FM

An optional radio station made on this computer, hidden until you turn on **Settings → Delulu FM**. Every song is new: the cleanup model writes its title, style and lyrics, [YuE2](https://huggingface.co/m-a-p/YuE2-3B) composes it in your own ComfyUI, and between songs a host speaks through voice replies with Chatterbox Turbo's bundled voice. The **Delulu FM** page shows what is on air with its lyrics, what comes next and what played, and lets you skip, request a song or steer the mood and style.

- **What it needs:** ComfyUI with the native YuE2 nodes and the `yue2_3b_int8_convrot.safetensors` checkpoint, the [Comfy CLI](https://github.com/Comfy-Org/comfy-cli) (`comfy`) on your PATH, and the cleanup model. The host is optional; without the voice replies model the station plays music only. The page lists anything missing, with the Comfy CLI command that installs the checkpoint. Delulu never downloads music models and never starts, stops or unloads ComfyUI.
- **Dictation comes first:** the radio goes quiet while you hold the hotkey, and no new writing, music or speech starts while you dictate or just after. Work already running in ComfyUI keeps running.
- **Buffering:** a short programme is made ahead of playback (two songs or six minutes, at most three items). When nothing new is ready it replays a recent song. Playback is native, so it keeps playing with the window closed.
- **Recovery:** every step is saved. After a restart, a song already submitted to ComfyUI is collected, never submitted twice. A failed song is retried once, then the station pauses briefly.
- **Storage:** songs, history and settings live in `~/.local/share/delulu-talks/radio`.

On an RTX 4090 with a warm ComfyUI, writing a song takes about 1.5 s and YuE2 about 30 s for a 2–3 minute song. Generation and playback share the graphics card with dictation; leave room for both or keep the station off.

## Memory and disk

<p align="center">
  <img src="docs/assets/resources.svg" alt="About 0.4 GB of RAM and 4.6 GB of graphics memory with cleanup on; about 0.25 GB of RAM and 0.9 GB of graphics memory with cleanup off." width="100%">
</p>

Both models live on the graphics card. Process monitors such as htop show the `delulu-cleanup` helper at about 3 GB, but most of that is the model file mapped from disk: clean page cache the kernel drops when it needs the memory. Turning cleanup off stops the helper and frees its 3.7 GB of graphics memory.

## Development

You need Rust, Bun, the GTK and WebKitGTK development libraries, ALSA, Vulkan headers, glslc, SPIRV-Headers and clang.

```sh
bun install
bun run build:helper   # the delulu-cleanup helper (llama.cpp with Vulkan)
DELULU_CLEANUP_HELPER=$PWD/target/release/delulu-cleanup bun run dev
```

`tauri dev` does not build the cleanup helper and only looks for it next to the debug binary, so point `DELULU_CLEANUP_HELPER` at the release build (or link it into `target/debug/`). The helper is a separate process because whisper.cpp and llama.cpp each bundle their own, incompatible copy of ggml. On Fedora, if clang cannot find its headers, set `BINDGEN_EXTRA_CLANG_ARGS` to the GCC include directory.

Checks: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `bun run typecheck`, `bun test ui` and `bun run format:check`. Pushing a `vX.Y.Z` tag builds the packages and publishes the release, with notes from `docs/releases/<tag>.md`.

## License

[MIT](LICENSE). The Parakeet model is [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) (CC BY 4.0), downloaded as the [int8 ONNX export by istupakov](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx).

## Spoken agent replies

Linux release packages include `delulu` (the Python adapter and agent skill are
embedded in the binary; no checkout is required). The optional CLI gives agent harnesses on-demand speech output through
[Chatterbox Turbo](https://huggingface.co/ResembleAI/chatterbox-turbo). It is separate
from the desktop binary, so it does not start dictation, acquire the microphone,
or change the app's listening behavior.

```sh
cargo build --release -p delulu-voice-cli
./target/release/delulu setup   # lightweight: binary/config/skill, no model download
delulu install-model            # optional, explicit ~3 GB download
# setup installs ~/.local/bin/delulu; include ~/.local/bin on PATH
delulu speak 'Done. The fix is ready for review.'
printf '%s' 'The build passed.' | delulu speak
```

Setup reuses the existing AI Director Flash Python environment at
`~/.local/share/ai-director/chatterbox_flash_local/.venv/bin/python`. To choose
another environment with `torch`, `chatterbox-tts` (Turbo API), `soundfile` and
`huggingface_hub`, pass `--python /path/to/venv/bin/python`. It never installs or
upgrades packages in that environment. `uv` prepares a small private setuptools
compatibility overlay for Perth; no second CUDA stack is installed. Install
[uv](https://docs.astral.sh/uv/) if missing. Playback requires PipeWire's `pw-play`.
This CLI currently targets Linux.

Only `delulu install-model` downloads roughly 3 GB of official Turbo weights into
the standard Hugging Face cache, including the bundled default speaker. Ordinary
app installation, first launch, opening Settings, and `delulu setup` never download
model weights. Setup reuses compatible cached weights when present. Without weights,
`speak` fails with installation guidance; inference cannot download missing assets.
Flash weights and voice references are never reused. Model installation pins the resolved model revision in
`~/.local/share/delulu-talks/voice/config.json` (or `$XDG_DATA_HOME` equivalent).
Repeating setup reuses downloads and that revision. Setup checks dependencies and
assets without loading a GPU model. Use `--device cpu` for CPU inference; CUDA is
the default. `--reference /path/to/voice.wav` explicitly chooses a voice clip longer
than five seconds. Setup preserves an existing device and reference when omitted.
Use `delulu setup --default-voice` to restore the official default speaker.
No configured voice from another app is read.

Setup also installs the short `delulu-speak` skill into `$CODEX_HOME/skills`
(default `~/.codex/skills`) and existing `~/.claude/skills` / `~/.agents/skills`
directories. It preserves customized skill files and all unrelated preferences.
The skill activates for requested spoken output or an active voice conversation:
it asks agents to speak concise replies and completion reports, not entire written
answers or constant progress updates. Existing `delulu-voice` listening sessions
keep their response-ID and interruption flow, without duplicate speech.

`delulu status` prints JSON readiness without starting Python. The GUI's Settings
section shows this readiness and offers an explicit optional Install model action.
Each `speak` loads Turbo, generates
locally and exits the Python process before playback, freeing GPU memory. Speak
works offline after model installation. Concurrent Delulu setup/speech jobs queue under a
per-user lock; they do not stop other applications or coordinate other apps' GPU
usage. Leave sufficient GPU memory free, or select CPU. Ctrl-C / SIGTERM cancels
the active owned subprocess and returns 130 / 143; failures return 1. A job waiting
for the lock gives up after ten minutes, and an active subprocess after thirty.

For silent verification or a headless harness, save a WAV instead of playing it.
`--volume 0` exercises real playback with a muted stream without changing system volume:

```sh
delulu speak --output /tmp/reply.wav 'The change is ready.'
printf '%s' 'The build passed.' | delulu speak --output /tmp/reply.wav
delulu speak --volume 0 'Silent playback check.'
```

Normal `speak` always plays through the current default PipeWire output; it never
changes system volume. Missing dependencies, incomplete setup, synthesis and
playback failures are reported on stderr. Text is passed by a private temporary
file, never interpreted as shell code; temporary audio and text are deleted on
normal completion and handled cancellation. Hard kills can leave a temporary job
directory but no resident inference worker. Keep replies short; the input cap is
16,000 UTF-8 bytes and Turbo is intended for English speech.

Local verification evidence and limitations: [voice verification](docs/voice-verification.md).
