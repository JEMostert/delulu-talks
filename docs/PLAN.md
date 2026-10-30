# Delulu Talks — plan

Delulu Talks is a local push-to-talk dictation app for Linux. Hold a hotkey,
speak, let go: the text is typed into the app you are using, in whatever
language you spoke (auto-detected; Dutch and English are the daily use).
Later it will let you talk to your coding agents by voice.

Everything runs on this machine: whisper.cpp (large-v3-turbo) on the GPU via
Vulkan, CPU fallback, and Gemma 4 E4B for cleanup in a separate helper process
(llama.cpp, Vulkan). The app itself has no Python and no runtime installer.

Two optional extras lean on what the user already has installed, and the app
never installs or starts those runtimes:

- **Voice replies** (`delulu` CLI): Chatterbox Turbo in an existing Python
  environment; the model downloads only on an explicit Install.
- **LLM FM** (radio): YuE2 music in the user's own ComfyUI through the Comfy
  CLI, words from the cleanup model, the host through voice replies with the
  bundled speaker. Missing pieces are shown as steps to do, never downloaded.

## Build order (each step gated on the previous one being used daily)

1. Dictation: done in v1.0; v1.1 added cleanup, vocabularies, topics and
   smart context management
2. Voice (talk to coding agents)  ← next
3. Rewrite (2–3 presets, local LLM)

## Screens — every setting lives in exactly one place

- **First run** (three steps, then done): microphone (with level meter),
  hotkey + permission to type into other apps, model download.
  First run writes the same settings as Settings; it is not a second home.
- **Home**: big dictation status and hotkey hint; the last few transcripts
  with Copy and Insert again.
- **History**: search and delete past transcripts; each shows its language,
  cleanup topic and timing, with the raw text behind "Cleaned up".
- **Cleanup**: the Clean up text switch and the model download, plus
  vocabularies: shelves of terms shown as jars on a reef, with one-click
  starter shelves. A jar opens a dialog with all its words.
- **Voice**: step 2, not now.
- **LLM FM** (optional, hidden until Settings → LLM FM): what is on air with
  lyrics or the host's words, play/pause/skip/volume, up next and recently
  played, song requests and a folded Direction panel. Readiness steps appear
  only when something is missing. Off by default; nothing is made or played
  until Play. Dictation comes first: playback is silent while recording and no
  new radio work starts while dictating.
- **Settings**, one scrolling list of sections:
  - Input: microphone, the desktop's hotkey trigger with a Change… button
    (GNOME or KDE through the shortcut portal), start at login
  - Dictation: model, language (Automatic or one fixed language), smart
    context management, insert text with (Shift+Insert / Ctrl+V /
    Ctrl+Shift+V / Off = copy only)
  - Voice replies: optional spoken replies model
  - LLM FM: show the radio (one switch)
  - Models and providers: step 2/3 (API keys, LLMs)
  - Appearance: theme (system / light / dark), show the recording pill
  - About: version, GPU backend in use, data folder, project link

- **Tray menu**: Open, the current topic with Clear topic, Quit.
- **Recording pill**: a small click-through pearl at the bottom of the
  screen while you dictate (glows with your voice, breathes while
  transcribing, one word for results). It never takes focus, so the text
  still lands in the app you were using. Not a second home for settings.

No quick-settings panel, no separate Models page.
A new screen, panel or setting is added only after this page says where it
belongs.

## Step 1 is done when

- 20 mixed Dutch/English utterances are recognised in the right language and
  inserted into a focused app on GNOME or KDE Wayland;
- key release to text inserted is under ~1 s on the owner's GPU
  (logged per dictation and shown in History);
- the owner has used it daily for a week.

## Out of scope for v1

Audio-file transcription, more than 2–3 rewrite presets, a general voice assistant, TTS
voice cloning (the radio host uses the bundled speaker only), Windows, macOS,
API/editor plugins, AppImage, auto-update.
