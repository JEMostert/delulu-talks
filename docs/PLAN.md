# Delulu Talks — plan

Delulu Talks is a local push-to-talk dictation app for Linux. Hold a hotkey,
speak, let go: the text is typed into the app you are using, in whatever
language you spoke (auto-detected; Dutch and English are the daily use).
Later it will let you talk to your coding agents by voice.

Everything runs on this machine: whisper.cpp (large-v3-turbo) on the GPU via
Vulkan, CPU fallback, and Gemma 4 E4B for cleanup in a separate helper process
(llama.cpp, Vulkan). The app itself has no Python and no runtime installer.

Two optional extras, each with an explicit model download:

- **Voice replies** (`delulu` CLI): Supertonic 3 on the CPU in
  `delulu-engine tts` (ONNX Runtime, no Python), Dutch and English; the model
  (about 400 MB, OpenRAIL-M) downloads only on an explicit Install. Chatterbox
  Turbo in an existing Python environment stays as an opt-in.
- **Delulu FM** (radio): YuE2 music made natively by the `delulu-engine music`
  helper (ggml, Vulkan), words from the cleanup model, an AI host speaking the
  station's language through the native voice. The music model is an explicit
  download in Settings → Models; missing pieces are shown as steps to do.
  ACE-Step 1.5 turbo (acestep.cpp in the same engine, MIT weights, 3.5× real
  time with its 4B LM on a 5060 Ti against YuE2's 0.9×) is built in as a second
  engine; choosing it on the Delulu FM page follows. YuE2 stays the default until
  a blind listening test.

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
  cleanup topic and timing, with the raw text behind "Cleaned up". History
  and vocabulary live in one SQLite database (`delulu.db` in the data folder)
  with full-text search; a deleted transcript is removed from the file, not
  just hidden. The header sets how long transcripts are kept (Forever, 90, 30
  or 7 days; default Forever).
- **Cleanup**: the Clean up text switch and the model download, plus
  vocabularies: shelves of terms shown as jars on a reef, with one-click
  starter shelves. A jar opens a dialog with all its words.
- **Voice**: step 2, not now.
- **Delulu FM** (optional, hidden until Settings → Delulu FM): what is on air with
  lyrics or the host's words, play/pause/skip/volume, up next and recently
  played, song requests and a folded Direction panel. Readiness steps appear
  only when something is missing. Off by default; nothing is made or played
  until Play. Dictation comes first: playback is silent while recording and no
  new radio work starts while dictating.
- **Settings**, one scrolling list of sections:
  - Input: microphone, the desktop's hotkey trigger with a Change… button
    (GNOME or KDE through the shortcut portal), start at login
  - Dictation: model, language (Automatic within your languages, default
    Dutch and English, or one fixed language), smart context management, insert text with (Shift+Insert / Ctrl+V /
    Ctrl+Shift+V / Off = copy only)
  - Voice replies: the voice model (Install shows its licence), the agents'
    voice and the radio host's voice
  - Delulu FM: show the radio (one switch)
  - Models: the optional music model (download, cancel, delete)
  - Models and providers: step 2/3 (API keys, LLMs)
  - Appearance: theme (system / light / dark), show the recording pill
  - About: version, GPU backend in use, voice model credit, data folder,
    project link

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
voice cloning (the voices are the model's preset voices only), Windows, macOS,
API/editor plugins, AppImage, auto-update.
