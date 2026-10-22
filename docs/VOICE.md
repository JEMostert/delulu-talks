# Delulu Voice

Delulu Talks can speak as well as listen. Turn on **Speak out loud** on the Voice page, pick a voice model, and Delulu reads text aloud with a local text-to-speech model. Nothing leaves your machine.

The main use is a voice loop with a coding agent. You talk to one lead agent by dictating as usual. The lead agent runs its own subagents or threads (Claude Code subagents, Codex, T3 Code's orchestration) and briefs you out loud, the way a CEO briefs a board: what is done, what it needs from you, what broke. The design follows Grok's text-to-speech: text in, audio out, with inline tags for one-off sounds and wrapping tags for speaking styles.

## Voice models

| Size  | Model                                                                                    | Runs on                                  | Tags                                                                       |
| ----- | ---------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| Small | [Kokoro 82M](https://huggingface.co/hexgrad/Kokoro-82M) through sherpa-onnx (Apache-2.0) | Any CPU, ~5× real time                   | Pauses, pacing and volume. Laughs, sighs and emotions are skipped.         |
| Large | [Chatterbox Turbo](https://huggingface.co/ResembleAI/chatterbox-turbo) (MIT)             | NVIDIA GPU (~3 GB), Apple Silicon or CPU | Everything, performed natively. Can clone a voice from a 5–20 second clip. |

Both models are pinned to exact Hugging Face revisions (see `src/voice.ts`). The voice runtime is a separate Python environment (`voice-venv`), like the speech and rewrite runtimes: Kokoro needs only sherpa-onnx; Chatterbox adds PyTorch 2.11 and torchaudio 2.11. `chatterbox-tts` itself pins PyTorch 2.6 (which cannot run on Blackwell GPUs) and demo dependencies such as Gradio, so it is installed without dependencies and the packages its Turbo inference imports are pinned instead. `pip check` accepts only the expected `chatterbox-tts` lines.

Chatterbox applies Resemble AI's inaudible Perth watermark to its output. Kokoro does not watermark.

Measured on the reference machine (RTX 5060 Ti, Linux): Kokoro loads in under a second and synthesizes at about 0.2× real time on four CPU threads; Chatterbox Turbo loads in about 6 seconds, uses about 3 GB of GPU memory and synthesizes at about 0.18× real time.

## Markup

Write tags where a person would really make the sound. Unknown tags are skipped with a warning; ordinary brackets such as `[1]`, `[WIP]`, `Array<string>` and `a < b` stay text. Escape a bracket with a backslash: `\[laugh]`.

**One-off sounds:** `[laugh]` `[chuckle]` `[sigh]` `[gasp]` `[cough]` `[clear-throat]` `[sniff]` `[groan]` `[shush]`. Common variants work too: `[laughs]`, `[sighs]`, `[giggle]`, `[clear throat]`.

**Pauses:** `[pause]` (0.4 s), `[long-pause]` (1.2 s), or a length such as `[pause 800ms]` and `[pause 2s]` (up to 5 s).

**Wrapping styles:** `<whisper>…</whisper>` `<happy>…</happy>` `<angry>…</angry>` `<surprised>…</surprised>` `<scared>…</scared>` `<sarcastic>…</sarcastic>` `<dramatic>…</dramatic>` `<narration>…</narration>` `<crying>…</crying>`

**Pacing and volume:** `<slow>…</slow>` `<fast>…</fast>` `<soft>…</soft>` `<loud>…</loud>` `<emphasis>…</emphasis>`

Styles nest. A missing closing tag closes at the end of the text.

```text
[sigh] The build still fails on the cache path. Want me to try another way?
Done. All 212 tests pass [chuckle], and the cache fix is merged.
<whisper>Between us, that refactor was bigger than it looked.</whisper>
```

How each model performs the markup:

| Markup            | Chatterbox Turbo      | Kokoro                                                    |
| ----------------- | --------------------- | --------------------------------------------------------- |
| One-off sounds    | Native tokens         | Skipped, replaced by a short pause                        |
| Pauses            | Inserted silence      | Inserted silence                                          |
| Emotions, whisper | Native style tokens   | Whisper is quieter and slower; other emotions are skipped |
| Pacing, volume    | Time-stretch and gain | Native speed and gain                                     |

Each result reports the tags the model skipped.

## Code and file names

Coding agents write markdown. Unless **Read code and file names as words** is off, Delulu turns it into something worth hearing before speaking: code blocks become "Code omitted.", links keep their label, bare URLs become their host name, `src/hooks/useWorkspace.ts` becomes "source slash hooks slash use workspace dot T S", `v0.16.0` becomes "version 0 dot 16 dot 0", commit hashes are shortened, and emoji are dropped. Voice tags are never touched.

## Streaming, timestamps and interruption

Text is split into chunks at sentence boundaries; style changes always start a new chunk. The first chunk is short (about 140 characters), so speech starts quickly. Delulu synthesizes the next chunk while the current one plays, staying at most two chunks ahead. Each result includes timestamps for every chunk, measured from the synthesized audio, not estimated.

Starting a dictation stops speech, so you can answer right away (**Stop speaking when I start dictating**). Messages that arrive while Delulu is speaking wait in a queue of up to 20; an agent can also interrupt.

Playback is native (`delulu-audio`, through cpal: PulseAudio/PipeWire or ALSA on Linux, CoreAudio, WASAPI), so it works while the window is hidden or closed to the tray. You can pick an output device.

## Connecting a coding agent

Turn on **Let coding agents speak** on the Voice page. Delulu then listens on a local socket (`<user data>/voice/agent.sock` on Linux and macOS, a named pipe on Windows) and writes `bridge.json` beside it with a fresh random token. Both are readable only by your user. Requests without the token are refused.

The Voice page shows copyable setup for:

- **Claude Code:** `claude mcp add --scope user delulu-voice -- <delulu-talks> mcp`
- **Codex:** `codex mcp add delulu-voice -- <delulu-talks> mcp`
- **Any MCP client:** an `mcpServers` JSON block with `"command": "<delulu-talks>", "args": ["mcp"]`
- **A shell:** `<delulu-talks> mcp say "Done, all tests pass."`

`<delulu-talks>` is the full path of the installed app: for example `/usr/bin/delulu-talks` from the rpm, deb or pacman package, or the AppImage file itself (its path stays stable across updates, unlike the AppImage's mount point).

T3 Code runs Claude Code and Codex, so it uses their MCP configuration.

`delulu-talks mcp` is the MCP server and CLI built into the app binary. It runs before any window starts, needs no Node, and reads `bridge.json` from the profile (`DELULU_VOICE_BRIDGE` overrides where). Agents registered by the Electron releases ran `node <user data>/voice/delulu-voice-mcp.mjs`; that script speaks the same protocol, so an existing copy keeps working where Node is installed, but re-register with the command above.

The MCP server offers three tools:

- `speak`: `text` with markup, optional `interrupt`, `wait` (default false: return as soon as it is queued) and `agent` (a display label).
- `stop_speaking`
- `voice_status`

The server's MCP instructions tell the agent when and how to speak. Copy the same text from the Voice page into your lead agent's `CLAUDE.md` or `AGENTS.md` so it briefs you like a colleague: only when work is done, blocked, needs a decision or broke; one to three sentences; never code read aloud.

The CLI:

```text
delulu-talks mcp say [--wait] [--interrupt] [--agent NAME] [--response ID] <text…>   (use - to read stdin)
delulu-talks mcp stop
delulu-talks mcp status
```

Desktop shortcuts can also run the app itself: `delulu-talks --read-clipboard` reads the clipboard aloud and `delulu-talks --stop-speaking` stops. Both are in the tray menu too.

## Listening sessions

A listening session turns Delulu into a voice conversation with a coding agent. The agent starts a session once; Delulu then keeps the microphone open and the speech model loaded across turns, detects when you start and stop talking, transcribes each completed utterance and queues it. The agent collects utterances with short waiting calls, answers aloud with `say`, and waits again. Ending a waiting call (an answer, a timeout, a cancel or a disconnect) never stops the session or unloads the model; only `listen stop`, quitting the app or an unrecoverable failure does.

While a session runs, the Voice page and the tray show that Delulu is listening and offer **Stop listening**. Dictating with your shortcut still works: the session ignores the microphone during a dictation and resumes afterwards.

### A complete session

```text
DV='/usr/bin/delulu-talks mcp'
$DV listen start --client claude-code
  → {"id":"ses_8f…","state":"listening","ackedSeq":0,"lastSeq":0,"queued":0,…}
$DV listen next --session ses_8f… --after 0 --timeout 600     # run in the background
  → exit 0  {"status":"event","event":{"seq":1,"type":"utterance","id":"utt_…","text":"Can you run the tests?",…}}
$DV say --response rsp_1 "Sure, running them now."
$DV listen next --session ses_8f… --after 1 --timeout 600     # next waiter, acknowledges seq 1
  → exit 0  {"status":"event","event":{"seq":2,"type":"interrupted","responseId":"rsp_1",…}}
$DV listen next --session ses_8f… --after 2 --timeout 600
  → exit 0  {"status":"event","event":{"seq":3,"type":"utterance","text":"Actually, only the unit tests.","interruptedResponseId":"rsp_1",…}}
$DV listen stop --session ses_8f…
```

`listen next` exits 0 for an event, 3 for a timeout (start another waiter), 4 when the session has stopped, and 1 on errors (JSON on stderr). `listen ack --session ID --after SEQ` acknowledges without waiting, and `listen status [--session ID]` reports the session. The MCP server offers the same as tools: `listen_start`, `listen_next` (50-second default wait so hosts do not time the call out), `listen_ack`, `listen_status` and `listen_stop`; `speak` takes a `responseId`.

The agent skill in [`skills/delulu-voice/SKILL.md`](../skills/delulu-voice/SKILL.md) describes this loop for agents.

### Delivery rules

- Every event in a session has an increasing `seq`: `utterance` (your transcribed words), `interrupted` (Delulu stopped talking because you started) and `stopped` (the session ended).
- `next` returns the first event after the acknowledged cursor and keeps it until it is acknowledged. Passing `after: N` acknowledges every event up to N. Repeating a call with the same `after` returns the same event, so retries, timeouts and reconnects never lose input. Delivery is at least once: an agent that does not advance the cursor can see an event twice and should skip repeated utterance ids.
- Events are kept, in order, while nobody is waiting. Up to 200 unacknowledged events are kept per session.
- A session belongs to the client that started it. Starting again with the same client returns the same session; another client gets `SESSION_BUSY` and cannot read it. Only one session listens at a time, because there is one microphone.
- `interrupted` always comes before the utterance that caused it, so "playback stopped, you are still talking" is distinct from "a new transcript is ready". The utterance carries `interruptedResponseId`. Interrupted speech is never replayed.

### Speech detection

Delulu captures the microphone natively (`delulu-audio::ListenCapture`) and continuously, resampled to 16 kHz, and runs voice-activity detection on 20 ms frames: energy above an adaptive noise floor, a speech-band energy ratio, and a minimum stretch of sustained speech, so a cough, a click or a door does not start a turn. Half a second of pre-roll is kept, so the first word is never clipped. An utterance ends after the quiet pause set by **Pause before your turn ends** (default 0.9 s) and is transcribed with the selected speech model. Too-short sounds and empty transcripts are dropped. **Listening sensitivity** trades quiet speech against background noise.

### Interrupting Delulu (barge-in)

Detection keeps running while Delulu speaks. When you talk over it for **Talk-over time** (default 0.3 s) of sustained speech, the listener stops native playback at once, without waiting for a transcript. The app drops the rest of that response and anything queued behind it, discards synthesis still in flight, and refuses any late audio from it, so it cannot resume. Your utterance, including its pre-roll from before playback stopped, is finalized after the normal pause and delivered as the next input.

Keeping Delulu's own voice out of the microphone uses two layers:

1. Playback-reference gating (the echo gate): while Delulu is speaking, the detector knows its own output level from the native player and requires the microphone to be clearly louder than the echo it has learned to expect, for longer, before treating it as speech.
2. A transcript that closely matches what Delulu said in the last minute is discarded (unless the user had just interrupted it) instead of delivered, so leaked playback cannot start a self-conversation.

There is no acoustic echo canceller or noise suppressor: the Electron releases used Chromium's WebRTC echo cancellation, which native capture does not have. This is not full-duplex echo cancellation. With loud speakers close to the microphone, barge-in can miss quiet speech or, rarely, trigger on Delulu's own voice. Headphones make it reliable. Turn off **Talk over Delulu to interrupt** to keep listening without barge-in.

### Agent hosts

- **Claude Code:** run `listen next` with the Bash tool in the background. A finished background task notifies the agent and wakes it even when idle, so your next utterance reaches it as soon as it is transcribed. While the agent is mid-response or running tools, it sees the result at its next turn boundary. Your speech stops Delulu's audio immediately either way, because the app does that itself.
- **T3 Code:** behaves like the provider it runs.
- **Codex CLI and other hosts:** a finished background command may not wake an idle agent (not verified). The fallback is a foreground `listen next` with a bounded timeout when the agent has nothing else to do. No host should poll `listen status` in a loop.

## Bridge protocol

Newline-delimited JSON over the socket. Requests: `{"v":1,"id":"…","token":"…","method":"hello"|"speak"|"stop"|"status"|"listen.start"|"listen.next"|"listen.ack"|"listen.status"|"listen.stop","params":{…}}`. Responses: `{"v":1,"id":"…","ok":true,"result":…}` or `{"v":1,"id":"…","ok":false,"error":{"code":"UNAUTHORIZED"|"INVALID_REQUEST"|"VOICE_UNAVAILABLE"|"SESSION_BUSY"|"SESSION_NOT_FOUND"|"INTERNAL","message":"…"}}`.

Limits: 256 KiB per request line, 16 connections, 4 requests in flight per connection, 15,000 characters per message (Grok's limit).

## Worker protocol

The voice runtime role accepts `voiceStatus`, `voiceLoad`, `voiceUnload`, `voiceSynthesize` and `shutdown`. A synthesis request is one chunk: `{engine, voice, reference?, speed, styles, parts}` where parts are `{kind:"text", text}`, `{kind:"event", tag}` or `{kind:"pause", ms}`, with at most 600 text characters and 200 parts. The result carries 16-bit mono PCM as base64 (at most 90 seconds, inside the 8 MiB response limit), its duration, processing time, device and skipped tags. Both sides validate every request and result (`src-tauri/crates/delulu-runtime/src/protocol.rs`, `backend/python/worker_protocol.py`).

## Limits

- Kokoro voices are English (American and British). Kokoro's other languages and Chatterbox's multilingual model are not offered.
- Chatterbox on a CPU works but is several times slower than real time.
- The Windows and macOS voice runtimes use the same pins but have not been validated on native hardware.
- Voice cloning copies the chosen clip into `<user data>/voice/references`. Only clone voices you have permission to use.
