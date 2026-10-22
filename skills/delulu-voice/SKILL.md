---
name: delulu-voice
description: Hold a spoken conversation with the user through Delulu Talks. Use when the user asks to talk by voice, to "listen", to have a voice conversation, or to be briefed out loud; covers starting a listening session, waiting for utterances in the background, answering aloud, interruptions and stopping.
---

# Delulu Voice

Delulu Talks keeps the microphone and speech model running in a **listening session** and queues each completed utterance (the user speaks, then pauses). You collect utterances with short, bounded waiting commands and answer out loud. Run everything through the CLI:

```
DV={{SCRIPT}}
```

Every `listen` command prints one JSON object on stdout. Errors exit 1 with `{"error":{"code","message"}}` on stderr.

## The loop

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
- A session belongs to the client that started it. Another client gets `SESSION_BUSY` and cannot read its transcripts. Use one session per agent.

## Speaking

- Speak when the user asked you something, when work is done, when you are blocked or need a decision. One to three short sentences, like a colleague. Never read code, diffs, logs or long lists aloud; name the file or outcome instead.
- Expressive tags, sparingly: `[laugh] [chuckle] [sigh] [gasp] [cough] [clear-throat] [sniff] [groan] [shush] [pause] [long-pause]`, and spans `<whisper>…</whisper> <happy>… <angry>… <surprised>… <scared>… <sarcastic>… <dramatic>… <narration>… <crying>… <slow>… <fast>… <soft>… <loud>… <emphasis>…`.
- `$DV stop` stops Delulu talking. It only affects speech; it never stops your coding work or the listening session.

## What the host can and cannot do

Background waiting only helps if your host tells you when the command finishes.

- **Claude Code:** a background Bash task that finishes notifies you and re-invokes you, even when you are idle, so a finished waiter wakes you with the user's words. While you are in the middle of a response or a tool call, you see it at your next turn boundary, not instantly. An interruption stops Delulu's audio immediately (the app does that, not you); you learn about it when the waiter returns.
- **T3 Code:** behaves like the provider it runs. With Claude Code, as above.
- **Codex CLI and other hosts:** a finished background command may not wake an idle agent (unverified; assume it does not). Fall back to running `listen next` in the foreground with a bounded timeout (for example `--timeout 120`) when you have nothing else to do, then loop. Do not busy-poll `listen status`.
- **MCP:** the same operations exist as tools (`listen_start`, `listen_next` with a default 50 s wait, `listen_ack`, `listen_status`, `listen_stop`, `speak` with `responseId`). A tool call blocks you while it waits, so prefer the CLI in the background when your host supports it.

## Failures

- `Delulu Talks isn't running…`: ask the user to open Delulu and turn on agent voice on its Voice page.
- `SESSION_NOT_FOUND`: the session ended (app restarted). Start a new one only if the user still wants to talk.
- Speech model or microphone errors arrive as `stopped` with a reason, or as an error from `listen start`. Tell the user in text; do not loop.
