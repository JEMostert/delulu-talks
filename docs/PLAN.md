# Delulu Talks — plan

Delulu Talks is a local push-to-talk dictation app for Linux. Hold a hotkey,
speak, let go: the text is typed into the app you are using, in whatever
language you spoke (auto-detected; Dutch and English are the daily use).
Later it will let you talk to your coding agents by voice.

Everything runs on this machine: whisper.cpp (large-v3-turbo) on the GPU via
Vulkan, CPU fallback. One binary, no Python, no runtime installer.

## Build order (each step gated on the previous one being used daily)

1. Dictation  ← now
2. Voice (talk to coding agents)
3. Rewrite (2–3 presets, local LLM)

## Screens — every setting lives in exactly one place

- **First run** (three steps, then done): microphone (with level meter),
  hotkey + permission to type into other apps, model download.
  First run writes the same settings as Settings; it is not a second home.
- **Home**: big dictation status and hotkey hint; the last few transcripts
  with Copy and Insert again.
- **History**: search and delete past transcripts.
- **Voice**: step 2, not now.
- **Settings**, one scrolling list of sections:
  - Input: microphone, active GNOME hotkey trigger with a Change… button, start at login
  - Dictation: model, language (Automatic or one fixed language),
    insert text with (Shift+Insert / Ctrl+V / Ctrl+Shift+V / Off = copy only)
  - Voice: step 2
  - Models and providers: step 2/3 (API keys, LLMs)
  - Appearance: theme (system / light / dark), show the recording pill
  - About: version, GPU backend in use, data folder, project link

- **Recording pill**: a small click-through pearl at the bottom of the
  screen while you dictate (glows with your voice, breathes while
  transcribing, one word for results). It never takes focus, so the text
  still lands in the app you were using. Not a second home for settings.

No quick-settings panel, no separate Models page.
A new screen, panel or setting is added only after this page says where it
belongs.

## Step 1 is done when

- 20 mixed Dutch/English utterances are recognised in the right language and
  inserted into a focused app on GNOME Wayland;
- key release to text inserted is under ~1 s on the owner's GPU
  (logged per dictation and shown in History);
- the owner has used it daily for a week.

## Out of scope for v1

Audio-file transcription, vocabulary/personalisation UI (unless accuracy
demands it), more than 2–3 rewrite presets, a general voice assistant, TTS
voice cloning, Windows, macOS, CLI/API/editor plugins, AppImage, auto-update.
