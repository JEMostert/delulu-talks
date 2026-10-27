# Voice helper redesign

Status: implemented for v0.3.0; see [Overnight results](#overnight-results).
The sections before it describe v0.2.0 and the plan.

Since the rebrand the Voice page is called Siren, Talk is Sonar and the helper
is Pilot. This record keeps the names used at the time; code identifiers
(`talk.rs`, `coordinator_engine.py`) did not change.

## What goes wrong in v0.2.0

Found while testing v0.2.0 live on CachyOS / KDE Wayland with a USB headset.

Bugs:

1. Agents register by client name (`coordinator.rs`, `agent.register`), so two
   sessions of the same agent share one inbox and take each other's tasks.
2. Agents never expire and the active agent is persisted. When a session ends,
   new tasks still queue into its inbox.
3. `flush_turns` joins every pending turn into one text and routes it once.
   "Fix X" followed by "stop talking" gets a single intent.
4. Every coordinator briefing uses `interrupt: true`, so "Queued for your
   agent" cuts off an agent's own spoken answer.
5. `change()` rewrites and fsyncs the whole store on every mutation, including
   each `agent next --after` acknowledgement. `applied_requests` keeps up to
   2048 entries with their full text.

Design:

6. The helper only labels: six intents, canned English replies, and
   `conversation` is a dead end. In the live test every Dutch turn answered
   "I'm listening. You can give your agent a task…".
7. Two microphone owners and two protocols. Direct listening sessions and the
   coordinator inbox compete for one microphone (`SESSION_BUSY`), and the
   skill still documents listening sessions.
8. A finished turn waits for a 1 s listen timeout before it is routed.
9. The ~1100-token classification prompt is processed from scratch each turn;
   no prefix cache.
10. A separate torch + transformers process for a 0.8B model; the app peaked
    at 8.6 GB.
11. Follow-up and cancellation guards are English regular expressions.

UX:

12. The helper's microphone is started from step 4 ("Talk back to your
    agents"), and loading the helper does not start it. There is no input level
    or device indicator: the system default input was a silent jack and nothing
    showed it.
13. Setup, load and mode are internal states exposed as separate steps.

Worth keeping: verbatim forwarding of the user's words, the durable
sequence/ack inbox, outputs restricted to known IDs, and keeping recordings
across interruptions.

## Proposed architecture

- One conversation loop in Rust: microphone → voice activity → speech
  recognition → helper → tool executor → speech output.
- The helper is a forced tool caller. Every turn is exactly one call:
  - `send_to_agent(agent?, task?)`: the user's exact words are forwarded; the
    model never writes task text.
  - `task_status(task?)`.
  - `cancel_task(task)`: always asks for spoken confirmation.
  - `stop_speaking()`, `stop_listening()`.
  - `reply(text)`: one short sentence in the user's language. Generated text
    is only ever spoken, never sent to an agent.
    Arguments are limited to existing task and agent IDs.
- One agent protocol: a single inbox. With the helper off, every turn goes to
  the active agent as `send_to_agent`, so direct mode is the same loop without
  a model.
- Agent identity per session with a heartbeat; dead agents stop receiving work.
- Briefings wait for silence instead of interrupting.
- Append-only inbox log instead of whole-store rewrites.
- Cache the fixed prompt prefix (system text, tools, examples); target under
  0.5 s per turn on GPU.
- UI: one Talk switch with a live level meter and input picker; the helper
  section is only a model picker.

## Prototype results

`scripts/voice-helper-eval/` runs the real cached model on 34 English and
Dutch phrases (`cases.json`). Qwen3.5-0.8B:

| Approach                                                        | Correct |
| --------------------------------------------------------------- | ------: |
| Free tool calling (model may answer in text)                    |   11/34 |
| Forced tool call, name chosen by probability                    |   29/34 |
| Forced, calibrated against a neutral turn, contrasting examples |   32/34 |

Free tool calling also claimed actions it did not take ("de microfoon is nu
uit" without calling the tool). Remaining misses with calibration: "What can
you do?" went to the agent (harmless), and "Eigenlijk, sla de trage tests
over" chose `cancel_task`, which is why cancellation needs confirmation.
Prototype latency is about 1.5 s per turn because it reprocesses the prompt
for every tool name; reusing the prefix cache removes most of that.

The 2B model has not been measured.

## Interim changes in this commit

These predate the redesign and will be replaced by it:

- Dutch example turns and Dutch follow-up/cancel cues in
  `backend/python/coordinator_engine.py` (Dutch test phrases 3/10 → 10/10).
- Fixed-phrase rules for stop speaking / stop listening, with the model no
  longer allowed to pick those intents. Per review, these should become tool
  calls the helper makes, not rules.
- A smaller Voice helper section on the Voice page.

## Overnight results

Built on 2026-10-23 on the Fedora workstation (RTX 5060 Ti 16 GB). This
machine has no `~/.config/Delulu Talks` profile and no `magic-venv`, so the
eval ran with the system Python (transformers 5.8.1, torch 2.12, no
flash-linear-attention kernels) against the pinned Qwen3.5-0.8B revision
(`2fc06364…`) from a local copy, linked into a `/tmp` Hugging Face cache.
Nothing was downloaded. The release build pins transformers 5.15.

### What was built

One live conversation loop (`delulu-voice/src/talk.rs`):

- Talk owns the microphone. Each finished utterance is routed on its own, in
  order, as soon as it is transcribed: no joined turns, no listen timeout.
- Barge-in still stops playback at once, and the interrupted line is marked
  in the next turn's memory.
- The first sentence of any line is its own synthesis chunk.
- Delulu never interrupts speech except for `stop_speaking`. Agents' `say`
  queues behind current speech while Talk is on.
- `completed`, `blocked` and `failed` updates are coalesced into one briefing,
  spoken at the next pause in the language of the user's last turn.
- Helper Off is the same loop: every turn goes to the active agent verbatim.
- Accepted recordings survive a quit in `voice/pending-audio/` and are retried
  at the next start.

The helper (`backend/python/coordinator_engine.py`) is a forced tool caller:

- Tools: `send_to_agent`, `task_status`, `cancel_task`, `stop_speaking`,
  `stop_listening`, `repeat_last` and `reply`, in Qwen's native format.
- The system text, tool schemas and 50 bilingual examples (including the
  contrast pairs) are processed once and their cache reused. Tool names are
  scored in one batched forward.
- Calibration subtracts a quarter of the neutral "N/A" prior for the same
  context shape. The full prior over-rewarded rarely chosen tools: with this
  prompt it cost two cases on the main set.
- The same utterance is also scored without tasks or memory, and that score
  is added (weight 1.0). Two end-to-end failures needed this: "Thanks!" with
  an open task went to `task_status`, and "Stop de deployment." with a busy
  memory went to `stop_listening`.
- Arguments are chosen among context ids. Words shared with a task title
  favour that task for status and cancel. An agent named in the utterance is
  used.
- Only `reply` generates text (at most 32 tokens).
- After `send_to_agent`, `task_status` and `cancel_task`, the executor reports
  a short English sentence. English turns hear it unchanged. Dutch turns hear
  a second, short cached call that rephrases it in Dutch.
- A Dutch rephrasing that loses an agent name or a quoted title is rejected,
  and the app speaks its own Dutch sentence instead. Giving the second call
  the full routing prompt and memory made it echo the user or invent
  "nobody is listening", so this is a deliberate narrowing.
- Cancel always asks for a spoken yes. A short yes (checked without the
  model) confirms only the remembered task; any other turn drops the cancel.
- Memory holds the last 6 turns. Only tasks of listening agents are offered
  to the helper.

Agents (`delulu-voice/src/inbox.rs`, CLI + MCP, `skills/delulu-voice/SKILL.md`):

- One durable inbox with a fresh id per session.
- Every call is a heartbeat. Agents are away after 120 s without a waiter or a
  call; away agents get no new tasks, and Delulu says "No agent is listening
  right now."
- Storage is `inbox.json` plus an append-only `inbox.log`. Only new work is
  synced, heartbeats are not written, and dedupe keeps hashes.
- `listen …` was removed rather than aliased: the CLI says what replaced it.
  Aliases would have kept a second microphone owner alive.

UI (Voice page):

- One Talk switch, with a level meter and a microphone picker beside it.
- A helper picker (Off / Lightweight · 0.8B) with one status line.
- One `Download (~1.7 GB)` confirmation, only when the files are missing.
- A three-turn transcript strip and a Talk indicator with Stop.
- Checked in the browser preview at 800×620 and 480×620.

Left out on purpose:

- The 2B model. A saved `conversational` setting reads as Lightweight.
- Language detection by the speech model: two small en/nl word lists decide
  the reply language (Python for the helper, Rust for fixed lines).
- Moving the helper out of its torch process (problem 10 above). Keeping only
  the last logits halved its GPU memory instead: about 2.2 GB peak, was 4.4.

### Eval (`scripts/voice-helper-eval/tools_eval.py`, production path)

Requests go through the worker's protocol validation and dispatch, exactly as
the app sends them.

| Set                                 | Score |
| ----------------------------------- | ----: |
| `cases.json` (34)                   | 34/34 |
| `heldout.json` (34 cases, 36 steps) | 33/34 |

The held-out set covers memory follow-ups ("Eigenlijk, sla de trage tests
over" → follow-up on the running task), `repeat_last`, cancel + "Ja." and
cancel + refusal. It was written before prompt tuning, but I looked at its
misses while tuning and added the four end-to-end cases afterwards, so it is
not fully blind. Remaining miss: "Stop the tests, they're too slow." →
`stop_listening`.

Latency on the GPU, 70 decide calls and 41 Dutch reply calls (English
results need no second call):

| Call                                       | Median |    p90 |    Max |
| ------------------------------------------ | -----: | -----: | -----: |
| decide (tool + arguments, or `reply` text) | 304 ms | 400 ms | 517 ms |
| reply (Dutch rephrasing)                   | 140 ms | 184 ms | 251 ms |
| whole helper turn                          | 356 ms | 476 ms | 672 ms |

The prototype took about 1.5 s per call. Loading the model and building the
prefix cache takes about 4.5 s, and the first Talk start pays it.

Time to first audio was not measured: this machine has no speech model or
Kokoro runtime in the dev profile. Estimate after you stop talking:

- the pause that ends a turn (0.9 s by default; 0.5–0.6 s is possible);
- recognition of a short utterance (about 0.1–0.3 s on the GPU, not measured
  here);
- the helper (0.3–0.5 s);
- Kokoro's first sentence (about 0.2× real time, so about 0.3 s).

That is roughly 1.6–2 s with default settings. The helper part meets its
target; the 1 s total needs a shorter pause setting.

### Checks

- `bun run typecheck`, `bun run format:check`: pass. `bun run test:unit`: 78 pass.
- `bun run test:python`: 67 tests, OK.
- `cargo test --workspace`: 342 passed, 0 failed, 6 ignored (hardware).
  Covers the executor, cancel confirmation, per-session ids, heartbeat expiry,
  one route per turn, non-interrupting briefings and status lines.
- `cargo clippy --workspace --all-targets`: no warnings.

End to end, without a microphone: `bun run tauri dev` on the dev profile,
with `DELULU_DEV_HELPER_PYTHON` / `DELULU_DEV_HELPER_CACHE` (debug builds
only) pointing at the system Python and the linked cache. Turns were injected
with `delulu-talks mcp talk inject` and read with `mcp agent next` and
`mcp task status`.

- Two registrations of the same client got different ids.
- With every agent away, "Maak de build sneller." queued nothing and said
  "Er luistert nu geen agent."
- A background `agent next` woke with the exact words.
- Two simultaneous turns ("Fix the login bug." and "Stop talking.") were
  routed separately: the agent got only the first.
- Status, follow-ups, `repeat_last`, stop speaking/listening and cancel +
  "Ja." (the cancel event reached the agent) all worked, with replies in the
  turn's language.
- The inbox survived a restart: the task stayed running and agents came back
  as away.
- The log holds no transcripts.
- Speech output is off in that profile and Kokoro is not installed there, so
  spoken lines were checked through the turn records. Briefings need Talk on,
  which needs a speech model, so they are covered by the Rust tests only.

The first end-to-end runs found five problems, all fixed:

- "Thanks!" went to `task_status`.
- "Stop de deployment." went to `stop_listening`.
- A cancel picked the newest task instead of the named one.
- Stale tasks from an earlier session turned new requests into undeliverable
  follow-ups.
- A Dutch title ending in a period confused the Dutch rephrasing.

### Known limitations

- A 0.8B model still misroutes now and then. In the last run, "No, keep it
  going." after a cancel question was forwarded to the agent as a follow-up,
  and "Eigenlijk, alleen de installatie-instructies." became a new task rather
  than a follow-up. Words always reach the agent verbatim, and cancelling
  always asks.
- English and Dutch only. Kokoro speaks Dutch lines with an English voice.

### Test live with a microphone in the morning

1. Switch Talk on with Lightweight selected. It should load without asking.
   Check that the level meter moves and that switching microphones while
   talking works.
2. Talk over a long agent `say`. It should stop at once; ask "wat zei je?".
3. Give a Dutch task, then a correction ("Eigenlijk, …"). Check that the
   agent gets a follow-up on the same task.
4. Let the agent report `completed` while you are speaking. The briefing
   should wait for the pause.
5. Time from the end of a sentence to Delulu's first audio, then try a 0.6 s
   pause.
6. Stop the agent session and wait 2 minutes. A new task should get "Er
   luistert nu geen agent".
