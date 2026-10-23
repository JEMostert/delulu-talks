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

Text is split into chunks at sentence boundaries; style changes always start a new chunk. The first sentence is a chunk of its own, so speech starts as soon as it is synthesized; later chunks hold up to about 140 characters. Delulu synthesizes the next chunk while the current one plays, staying at most two chunks ahead. Each result includes timestamps for every chunk, measured from the synthesized audio, not estimated.

Starting a dictation stops speech, so you can answer right away (**Stop speaking when I start dictating**). Messages that arrive while Delulu is speaking wait in a queue of up to 20. An agent can ask to interrupt, except while Talk is on (see [Speaking](#speaking)).

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

The MCP server offers these speech tools:

- `speak`: `text` with markup, optional `interrupt` (ignored while Talk is on), `wait` (default false: return as soon as it is queued) and `agent` (a display label).
- `stop_speaking`
- `voice_status`

Agents that should hear you use the [agent inbox](#agent-inbox).

The server's MCP instructions tell the agent when and how to speak. Copy the same text from the Voice page into your lead agent's `CLAUDE.md` or `AGENTS.md` so it briefs you like a colleague: only when work is done, blocked, needs a decision or broke; one to three sentences; never code read aloud.

The CLI:

```text
delulu-talks mcp say [--wait] [--interrupt] [--agent NAME] [--response ID] <text…>   (use - to read stdin)
delulu-talks mcp stop
delulu-talks mcp status
```

Desktop shortcuts can also run the app itself: `delulu-talks --read-clipboard` reads the clipboard aloud and `delulu-talks --stop-speaking` stops. Both are in the tray menu too.

## Talk

**Talk** on the Voice page is one live conversation loop: microphone → voice activity → speech recognition → helper → tool executor → speech output. It stays on until you switch it off, say "stop listening", quit, or the microphone fails. Next to the switch are a live input level meter and the microphone picker (the same **Microphone** setting dictation uses), so a silent or wrong input is obvious. Talk needs a speech model from Models; dictating with your shortcut still works and pauses Talk until the dictation ends.

Every finished utterance is routed on its own, the moment it is transcribed: nothing is joined with earlier turns and there is no listen timeout. The transcript strip under the switch shows your last turns, what Delulu did and what it said.

### The helper

The helper is a model picker: **Off** or **Lightweight · 0.8B** (Qwen3.5 0.8B, pinned, running locally in the writing runtime). Turning Talk on with the helper selected loads it from cached files automatically; only the first download asks once (**Download (~1.7 GB)**, more if the writing runtime is not installed yet).

With the helper on, every turn is exactly one tool call in Qwen's native tool format:

| Tool | What it does |
| --- | --- |
| `send_to_agent(agent?, task?)` | Forwards your exact words to a coding agent. `agent` only when you name one; `task` when you correct or follow up on an existing task. |
| `task_status(task?)` | Reports how tasks are going in one sentence. |
| `cancel_task(task)` | Asks first ("Cancel "Run the unit tests"? Say yes."). A spoken yes on the next turn cancels; anything else drops it. |
| `stop_speaking()` | Stops playback and the speech queue. |
| `stop_listening()` | Ends Talk and closes the microphone. |
| `repeat_last()` | Says the last spoken line again ("wat zei je?"). |
| `reply(text)` | One short sentence in your language: greetings, thanks, questions about Delulu. Factual or technical questions go to the agent. |

The model never writes task text: `send_to_agent` sends what you said, verbatim. After `send_to_agent`, `task_status` and `cancel_task` the executor reports what it did as a short English sentence ("Sent to Claude Code."); English turns hear it as is and Dutch turns hear it in Dutch, rephrased by the helper ("Doorgestuurd naar Claude Code."). The helper sees the connected agents, their open tasks and the last six turns (your words, the tool, what Delulu said, whether you interrupted it), so "Eigenlijk, sla de trage tests over" becomes a follow-up on the running task.

How it decides: the prompt (system text, tool schemas, bilingual examples with contrast pairs such as "Stop de deployment" → `send_to_agent` and "Stop talking" → `stop_speaking`) is processed once and its cache reused, so a turn only runs its own context block. Each allowed tool name is scored by log probability in one batched forward, a quarter of the score the same name gets for a neutral "N/A" turn is subtracted (calibration), and arguments are chosen among the ids in the context. Only `reply` generates text, at most 32 tokens. `scripts/voice-helper-eval/` measures this offline on the production code path; see [voice-redesign.md](voice-redesign.md) for scores and latency.

With the helper **Off**, the loop is the same without a model: every turn goes to the active agent as `send_to_agent`, and Delulu only speaks when nobody is listening.

### Speaking

Delulu's own lines, agents' `say`/`speak` and briefings share one speech queue. Nothing interrupts anything except `stop_speaking`; while Talk is on an agent's `interrupt` is ignored. Talking over Delulu still stops it at once (barge-in), and the cut-off line is marked in the next turn's context.

Briefings: when an agent reports `completed`, `blocked` or `failed`, Delulu queues one short line and plays it at the next pause, never while you are speaking, while a turn is being routed or while other speech plays. Several updates are coalesced into one line, in the language of your last turn.

### Speech detection

Delulu captures the microphone natively (`delulu-audio::ListenCapture`) and continuously, resampled to 16 kHz, and runs voice-activity detection on 20 ms frames: energy above an adaptive noise floor, a speech-band energy ratio, and a minimum stretch of sustained speech, so a cough, a click or a door does not start a turn. Half a second of pre-roll is kept, so the first word is never clipped. An utterance ends after the quiet pause set by **Pause before a turn ends** (default 0.9 s) and is transcribed with the selected speech model. Too-short sounds and empty transcripts are dropped. **Sensitivity** trades quiet speech against background noise.

If quitting interrupts an accepted recording before it is transcribed, it stays under private `voice/pending-audio/` and is retried the next time Talk starts.

### Interrupting Delulu (barge-in)

Detection keeps running while Delulu speaks. When you talk over it for **Interrupt after** (default 0.3 s) of sustained speech, the listener stops native playback at once, without waiting for a transcript. The app drops the rest of that response and anything queued behind it, discards synthesis still in flight, and refuses any late audio from it, so it cannot resume. Your utterance, including its pre-roll from before playback stopped, is finalized after the normal pause and routed as the next turn.

Keeping Delulu's own voice out of the microphone uses two layers:

1. Playback-reference gating (the echo gate): while Delulu is speaking, the detector knows its own output level from the native player and requires the microphone to be clearly louder than the echo it has learned to expect, for longer, before treating it as speech.
2. A transcript that closely matches what Delulu said in the last minute is discarded (unless the user had just interrupted it), so leaked playback cannot start a self-conversation.

There is no acoustic echo canceller or noise suppressor. With loud speakers close to the microphone, barge-in can miss quiet speech or, rarely, trigger on Delulu's own voice. Headphones make it reliable. Turn off **Stop Delulu when I talk over it** to keep listening without barge-in.

## Agent inbox

Coding agents receive your turns through one durable inbox per agent session, over the same CLI and MCP server (`delulu-talks mcp`). The [agent skill](../skills/delulu-voice/SKILL.md) teaches the loop.

```text
delulu-talks mcp agent register --client NAME [--name NAME]
delulu-talks mcp agent next --agent ID [--after SEQ] [--timeout SECONDS]
delulu-talks mcp agent ack --agent ID --after SEQ
delulu-talks mcp agent unregister --agent ID
delulu-talks mcp task status [--task ID]
delulu-talks mcp task update --agent ID --task ID --state STATE [--summary TEXT]
delulu-talks mcp talk status
```

- **One id per session.** `agent register` returns a fresh `agent_…` id on every call, even for the same client, so two sessions of the same agent never share an inbox.
- **Heartbeats.** Every agent call counts. An agent with a waiting `agent next` is listening; with no waiter and no call for 120 seconds it is away. Away agents get no new tasks and Delulu says "No agent is listening right now." instead of queueing silently. After the app restarts, every agent is away until it calls again.
- **Events.** `agent next` returns `{"status":"event","event":{"seq","type","taskId","text","at"}}` (exit 0) with `type` `task` (your exact words), `message` (a follow-up on `taskId`) or `cancel`; `{"status":"timeout"}` (exit 3); or `{"status":"stopped","reason"}` (exit 4: register again). Delivery is at least once: `--after N` acknowledges up to N, and the same cursor returns the same event again.
- **Progress.** `task update` reports `accepted`, `running`, `blocked`, `completed`, `failed` or `cancelled` with an optional one-sentence summary. Delulu briefs `completed`, `blocked` and `failed` itself. Unregistering marks the agent's open tasks failed.
- **Bounds.** Text and summaries up to 8000 characters, client and name 64, ids 128; at most 32 agents (away agents without open work are dropped first), 32 open tasks, 256 tasks of history and 256 queued events per agent.
- **Storage.** `voice/inbox.json` (a snapshot) and `voice/inbox.log` (append-only JSON lines), both private to your user. New tasks, follow-ups and cancels are synced to disk; acknowledgements and updates are appended without a sync, and heartbeats are not written at all. The log is folded into the snapshot when it passes about 1000 lines. Retried submissions are recognized by a bounded list of request ids and text hashes, never full texts.

MCP tools: `speak`, `stop_speaking`, `voice_status`, `agent_register`, `agent_next` (default wait 50 s), `agent_ack`, `agent_unregister`, `task_status`, `task_update` and `talk_status`. The `listen …` commands and tools of v0.2.0 are gone; the CLI prints that `agent register` / `agent next` replaced them.

### Agent hosts

- **Claude Code:** run `agent next` with the Bash tool in the background. A finished background task wakes the agent even when idle; mid-response it sees the result at its next turn boundary.
- **T3 Code:** wake-up depends on the provider and tool integration. Verify background completion notifications in the active host.
- **Codex CLI and other hosts:** a finished background command may not wake an idle agent (not verified). The fallback is a foreground `agent next` with a bounded timeout when the agent has nothing else to do. No host should poll `task status` in a loop.

## Bridge protocol

Newline-delimited JSON over the socket. Requests: `{"v":1,"id":"…","token":"…","method":"…","params":{…}}` with methods `hello`, `speak`, `stop`, `status`, `agent.register`, `agent.next`, `agent.ack`, `agent.unregister`, `task.status`, `task.update` and `talk.status` (debug builds also `talk.inject`). Responses: `{"v":1,"id":"…","ok":true,"result":…}` or `{"v":1,"id":"…","ok":false,"error":{"code":"UNAUTHORIZED"|"INVALID_REQUEST"|"VOICE_UNAVAILABLE"|"INTERNAL","message":"…"}}`.

Limits: 256 KiB per request line, 16 connections, 4 requests in flight per connection, 15,000 characters per message (Grok's limit).

## Worker protocol

The voice runtime role accepts `voiceStatus`, `voiceLoad`, `voiceUnload`, `voiceSynthesize` and `shutdown`. A synthesis request is one chunk: `{engine, voice, reference?, speed, styles, parts}` where parts are `{kind:"text", text}`, `{kind:"event", tag}` or `{kind:"pause", ms}`, with at most 600 text characters and 200 parts. The result carries 16-bit mono PCM as base64 (at most 90 seconds, inside the 8 MiB response limit), its duration, processing time, device and skipped tags. Both sides validate every request and result (`src-tauri/crates/delulu-runtime/src/protocol.rs`, `backend/python/worker_protocol.py`).

The helper runs in the writing runtime with the role `coordinator`: `coordinatorSetup` (the only command that may download), `coordinatorLoad` (cached files only), `coordinatorUnload`, `coordinatorDecide` (`{text, context}` → `{tool, args, language, confirmed?, elapsedMs}`) and `coordinatorReply` (`{text, context, call, result}` → `{text, elapsedMs}`). The context carries short `agent_N`/`task_N` aliases, at most 8 agents, 16 open tasks and 6 turns of memory; both sides reject unknown tools, arguments, ids outside the context and a `confirmed` that does not match the pending cancel.

## Limits

- Kokoro voices are English (American and British). Kokoro's other languages and Chatterbox's multilingual model are not offered.
- Chatterbox on a CPU works but is several times slower than real time.
- The Windows and macOS voice runtimes use the same pins but have not been validated on native hardware.
- Voice cloning copies the chosen clip into `<user data>/voice/references`. Only clone voices you have permission to use.
- The helper understands English and Dutch best; other languages are routed but answered in English. Kokoro speaks Dutch lines with an English voice.
- The helper is a 0.8B model: it can still pick the wrong tool (see the eval in [voice-redesign.md](voice-redesign.md)). Cancelling always asks first, and requests are forwarded verbatim.
