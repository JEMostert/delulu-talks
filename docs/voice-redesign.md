# Voice helper redesign (in progress)

Status: proposal plus a measured prototype. Nothing below is implemented in the
app yet. The v0.2.0 coordinator still runs as described in the code.

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
