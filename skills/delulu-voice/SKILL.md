---
name: delulu-voice
description: Hold a spoken conversation with the user through Delulu Talks. Use when the user asks to talk by voice, to "listen", to have a voice conversation, or to be briefed out loud; covers the optional local coordinator and durable agent inboxes, direct listening sessions, bounded waiting, briefings, interruptions and stopping.
---

# Delulu Voice

In direct mode, Delulu Talks keeps the microphone and speech model running in a **listening session** and queues each completed utterance (the user speaks, then pauses). You collect utterances with short, bounded waiting commands and answer out loud. Run everything through the CLI:

```
DV={{SCRIPT}}
```

Every `listen` command prints one JSON object on stdout. Errors exit 1 with `{"error":{"code","message"}}` on stderr.

## Choose the mode first

Check `$DV coordinator status` (`coordinator_status` over MCP). The coordinator is optional and local; it supports Qwen3.5 0.8B or 2B. Off/direct mode keeps the existing `say` and `listen` commands. Do not switch modes or load a model just because this skill is available.

When the coordinator is enabled, **register an agent inbox instead of opening a competing microphone session**. The coordinator owns the microphone and the single speaking voice. Workers report state and short briefings through `task update`; existing `say`/`speak` compatibility is routed by the app. Do not create a second speaker or talk over the coordinator.

## Coordinator inbox loop

1. Register with a stable client label for this worker, and keep the returned id and cursor:

   ```text
   $DV agent register --client codex-worker --name "Implementation"
   ```

   Returns `{id,client,name,ackedSeq,lastSeq,queued}`. Use distinct client labels for distinct workers. After reconnecting, resume from the returned `ackedSeq`.

2. Wait for your inbox using the actual id (the CLI default is 600 seconds):

   ```text
   $DV agent next --agent AGENT_ID --after 0 --timeout 120
   ```

   Exit **0** returns `{"status":"event","event":{"seq":1,"type":"task","taskId":"TASK_ID","text":"…",…}}`. Events can be `task`, `message`, or `cancel`. Exit **3** is `{"status":"timeout"}`; wait again with the same cursor. Exit **4** is stopped; stop waiting and inspect status before deciding whether to register again. Errors exit **1** as JSON on stderr.

3. Treat `event.text` as the exact original user task. Do not add a hidden instruction, rewrite it into a new prompt, or claim that the coordinator authorized extra work. Preserve ordinary host authorization and cancellation rules. For a task you take responsibility for:

   ```text
   $DV task update --agent AGENT_ID --task TASK_ID --state accepted
   $DV agent ack --agent AGENT_ID --after 1
   $DV task update --agent AGENT_ID --task TASK_ID --state running
   ```

   A durable queued event only means the input is stored. `accepted` means you took responsibility; `running` means you started the work. Acknowledgment advances delivery and is separate from task state. Do not report work started just because a task was queued or a waiter returned.

4. Report the actual outcome with a short summary for the coordinator's briefing:

   ```text
   $DV task update --agent AGENT_ID --task TASK_ID --state completed --summary "CLI is implemented; Rust checks pass."
   ```

   Other states are `blocked`, `failed`, and `cancelled`. Handle `message` as a follow-up and `cancel` as a cancellation request for the named task, respecting what the host can actually stop. Advance the cursor only after handling each event. Retry delivery is at least once: deduplicate by event sequence/task id so retries do not start the same work twice.

5. Wait again using the last handled sequence. On worker shutdown, run `$DV agent unregister --agent AGENT_ID`.

To inspect or route work:

```text
$DV coordinator status
$DV coordinator focus --agent AGENT_ID
$DV coordinator submit --text "The exact original user task" --agent AGENT_ID --request REQUEST_ID
$DV task status --task TASK_ID
$DV task status
```

Omit `--agent` on submit to use the focused agent. Reuse a request id when retrying the same submission. Keep the original text unchanged, including whitespace. Text and summary are limited to 8000 characters, client/name to 64, and ids to 128; blank or oversized values are rejected. `--after` is a nonnegative u64; CLI `--timeout` is 0–3600 seconds.

Equivalent MCP tools are `coordinator_status`, `coordinator_focus`, `coordinator_submit`, `agent_register`, `agent_next`, `agent_ack`, `agent_unregister`, `task_status`, and `task_update`. MCP arguments use `agentId`, `taskId`, `requestId`, `after`, `text`, `client`, `name`, `state`, and `summary` as applicable. `agent_next` takes integer `timeoutMs` (0–3600000; default 50000), rather than CLI seconds.

The CLI and MCP expose the same inbox to every harness. **They cannot automatically wake every idle host.** Use a background waiter only where completion notifications are supported, otherwise a bounded foreground wait. Host-specific adapters are optional; never claim an adapter exists or that a task was accepted without evidence. Do not busy-poll status.

## Direct listening loop

1. **Start once** (idempotent; reuse the id for the whole conversation):

   ```
   $DV listen start --client claude-code
   ```

   → `{"id":"ses_…","state":"listening","ackedSeq":0,"lastSeq":0,"queued":0,…}`

2. **Launch a waiter in the background** and keep working on whatever you were doing:

   ```
   $DV listen next --session ses_… --after <last seq you processed, 0 at first> --timeout 600
   ```

   In Claude Code, run it with the Bash tool's `run_in_background: true`. Never poll it in a loop.

3. **When it finishes, read its JSON** (exit code tells you the kind):
   - **0** `{"status":"event","event":{…}}` — an event:
     - `"type":"utterance"`: `{seq, id, text, durationMs, interruptedResponseId}`. This is the user talking to you. Treat `text` as their message.
     - `"type":"interrupted"`: `{seq, responseId}`. The user talked over your speech; playback already stopped and they are **still speaking**. Do not repeat or continue what you were saying. Start the next waiter (with `--after` this seq) to get their utterance, which carries `interruptedResponseId`.
     - `"type":"stopped"`: the session ended.
   - **3** `{"status":"timeout"}` — nothing was said. Start another waiter with the same `--after`.
   - **4** `{"status":"stopped","reason":…}` — the session was stopped (by the user, the app closing, or a failure). Tell the user briefly; do not restart unless they ask.

4. **Answer aloud**, briefly, with a fresh response id so interruptions can name it:

   ```
   $DV say --response rsp_<n> "Sure, running the tests now."
   ```

   `say` returns as soon as the speech is queued; it does not block your work.

5. **Launch the next waiter** with `--after <seq of the event you just handled>`, then continue working. Repeat from 3.

6. **When the user is done** with the conversation:
   ```
   $DV listen stop --session ses_…
   ```

## Delivery and acknowledgment

- Every event has an increasing `seq`. `listen next --after N` acknowledges N and everything before it, then returns the first event after N.
- Until acknowledged, an event is returned again by any waiter. Killing, cancelling or timing out a waiter loses nothing, and a retry with the same `--after` returns the same event.
- So: **always pass `--after` = the seq of the last event you finished handling**, and only advance it after you have acted on that event. If you ever see the same utterance `id` twice, you did not advance the cursor; skip the duplicate.
- `$DV listen ack --session ses_… --after N` acknowledges without waiting. `$DV listen status` shows the cursor, queued events and whether the user is speaking.
- Utterances spoken while no waiter is running stay queued.
- A session belongs to the client that started it. Another client gets `SESSION_BUSY` and cannot read its transcripts. Use one microphone-owning lead agent; workers use coordinator inboxes when enabled.

## Speaking

- Speak when the user asked you something, when work is done, when you are blocked or need a decision. One to three short sentences, like a colleague. Never read code, diffs, logs or long lists aloud; name the file or outcome instead.
- Expressive tags, sparingly: `[laugh] [chuckle] [sigh] [gasp] [cough] [clear-throat] [sniff] [groan] [shush] [pause] [long-pause]`, and spans `<whisper>…</whisper> <happy>… <angry>… <surprised>… <scared>… <sarcastic>… <dramatic>… <narration>… <crying>… <slow>… <fast>… <soft>… <loud>… <emphasis>…`.
- `$DV stop` stops Delulu talking. It only affects speech; it never stops your coding work or the listening session.

## What the host can and cannot do

Background waiting only helps if your host tells you when the command finishes.

- **Claude Code:** a background Bash task that finishes notifies you and re-invokes you, even when you are idle, so a finished waiter wakes you with the user's words. While you are in the middle of a response or a tool call, you see it at your next turn boundary, not instantly. An interruption stops Delulu's audio immediately (the app does that, not you); you learn about it when the waiter returns.
- **T3 Code:** wake-up depends on the provider and its tool integration. Verify completion notifications in the active host before relying on a background waiter; no automatic wake-up adapter is implied.
- **Codex CLI and other hosts:** a finished background command may not wake an idle agent (unverified; assume it does not). Fall back to running `listen next` in the foreground with a bounded timeout (for example `--timeout 120`) when you have nothing else to do, then loop. Do not busy-poll `listen status`.
- **MCP:** the same operations exist as tools (`listen_start`, `listen_next` with a default 50 s wait, `listen_ack`, `listen_status`, `listen_stop`, `speak` with `responseId`). A tool call blocks you while it waits, so prefer the CLI in the background when your host supports it.

## Failures

- `Delulu Talks isn't running…`: ask the user to open Delulu and turn on agent voice on its Voice page.
- `SESSION_NOT_FOUND`: the session ended (app restarted). Start a new one only if the user still wants to talk.
- Speech model or microphone errors arrive as `stopped` with a reason, or as an error from `listen start`. Tell the user in text; do not loop.
