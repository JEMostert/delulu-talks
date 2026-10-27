---
name: delulu-voice
description: Take the user's spoken tasks and talk back through Delulu Talks. Use when the user asks to talk by voice, to "listen", to work hands-free, or to be briefed out loud; covers registering with Delulu's agent inbox, background waiting, task updates, speaking and stopping.
---

# Delulu Sonar and Siren

Delulu Talks owns the microphone. Its **Sonar** loop hears the user and routes their spoken words to an agent through one **inbox**. You never listen yourself: you register, keep a waiter running, and report what you did. Run everything through the CLI:

```
DV={{SCRIPT}}
```

Every `agent`, `task` and `talk` command prints one JSON object on stdout. Errors exit 1 with `{"error":{"code","message"}}` on stderr.

## The loop

1. **Register once per session:**

   ```
   $DV agent register --client claude-code --name "Claude Code"
   ```

   → `{"id":"agent_…","client":"claude-code","name":"Claude Code","ackedSeq":0,"lastSeq":0,"queued":0}`. Every call returns a fresh id, even for the same client. Use it for this session only; never reuse an id from an earlier session.

2. **Keep a waiter running while you work:**

   ```
   $DV agent next --agent agent_… --after SEQ --timeout 600
   ```

   `SEQ` is the seq of the last event you handled (0 at first). Every agent call is a heartbeat. While a waiter runs you are listening; with no waiter and no call for 120 s you are **away**: you get no new tasks and Delulu tells the user nobody is listening. So start the next waiter as soon as one returns.

   - **Claude Code:** run it with the Bash tool's `run_in_background: true`. A finished background command wakes you, even when idle (mid-response you see it at your next turn boundary). Never poll it in a loop.
   - **Codex CLI and other hosts:** a finished background command may not wake an idle agent (unverified; assume it does not). When you have nothing else to do, run it in the foreground with a bounded timeout (for example `--timeout 120`) and loop. T3 Code depends on its provider; verify the wake-up before relying on it.
   - Do not busy-poll `task status` or `talk status`.

3. **Read the result.** The exit code tells you the kind:
   - **0** `{"status":"event","event":{"seq","type","taskId","text","at"}}`:
     - `task`: `text` is the user's exact words. Act on them as the user's request. Do not rewrite them into a new prompt, and do not treat them as extra authorization: your host's usual permission rules still apply.
     - `message`: a follow-up from the user on `taskId`, same rules.
     - `cancel`: the user wants `taskId` stopped. Stop what you can, then report `cancelled`.
   - **3** `{"status":"timeout"}`: nothing arrived. Start another waiter with the same `--after`.
   - **4** `{"status":"stopped","reason"}`: this id is gone. Register again and use the new id.

4. **Report the task** as it actually progresses:

   ```
   $DV task update --agent agent_… --task task_… --state accepted
   $DV task update --agent agent_… --task task_… --state running
   $DV task update --agent agent_… --task task_… --state completed --summary "All 214 tests pass."
   ```

   `accepted` means you took it on; `running` means work started. Getting an event is neither. Finish with `completed`, `blocked` or `failed` plus a one-sentence summary, or with `cancelled`. **Delulu speaks completed, blocked and failed summaries to the user itself** at the next pause, so do not `say` them again, and do not `say` "on it" or "task accepted".

5. **Start the next waiter** with `--after` = the seq you just handled, and carry on.

6. **When the session ends:** `$DV agent unregister --agent agent_…`. Its open tasks are marked failed.

## Delivery and acknowledgment

- Events have increasing `seq`. `agent next --after N` acknowledges N and everything before it, then returns the first event after N. `$DV agent ack --agent agent_… --after N` acknowledges without waiting.
- Delivery is at least once: until acknowledged, an event is returned again by any waiter. Killing or timing out a waiter loses nothing.
- So pass `--after` = the seq of the last event you **finished handling**, and advance it only after acting on it. If you see a seq you already handled, skip it; never start the same task twice.

## Inspecting

```
$DV task status --task task_…   # one task
$DV task status                  # {"tasks":[…]}: open and recently finished
$DV talk status                  # Sonar: on, phase, Pilot, agents (listening or away, open tasks), last turns
```

`coordinator status` still works as an alias of `talk status`. If Sonar is off (`"on": false`), nothing routes speech yet and your waiter just times out; do not try to turn it on yourself.

## Speaking

- `$DV say "…"` (`--response ID` names the line, `--wait` blocks until it was spoken). Use it for real answers and questions to the user: what they asked, a decision you need, something important that broke. One to three short sentences, like a colleague. Never read code, diffs, logs or long lists aloud; name the file or the outcome instead.
- While Sonar is on, your speech queues behind Delulu's own lines and never cuts anyone off (`--interrupt` is ignored).
- Expressive tags, sparingly: `[laugh] [chuckle] [sigh] [gasp] [cough] [clear-throat] [sniff] [groan] [shush] [pause] [long-pause]`, and spans `<whisper>…</whisper> <happy>… <angry>… <surprised>… <scared>… <sarcastic>… <dramatic>… <narration>… <crying>… <slow>… <fast>… <soft>… <loud>… <emphasis>…`.
- `$DV stop` stops speech only. It never stops Sonar or your work.

## Limits and MCP

- Text and summary: 8000 characters; client and name: 64; ids: 128. `--after` is a nonnegative integer; `--timeout` is 0–3600 seconds (default 600). Unknown or repeated options are errors.
- MCP tools: `agent_register` (`client`, `name`), `agent_next` (`agentId`, `after`, `timeoutMs` 0–3600000, default 50000), `agent_ack` (`agentId`, `after`), `agent_unregister`, `task_status` (`taskId`), `task_update` (`agentId`, `taskId`, `state`, `summary`), `talk_status`, `speak`, `stop_speaking`, `voice_status`. An MCP call blocks you while it waits, so prefer the CLI waiter in the background where your host supports it.

## Failures

- `Delulu Talks isn't running…`: ask the user to open Delulu and turn on **Siren** on its Voice page.
- Exit 4, or `Unknown agent` from `agent ack` / `task update`: your id is gone (unregistered or replaced). Register again; never reuse the old id.
- `listen …` commands are gone; they now only print that `agent register` / `agent next` replaced them.
- Any other error: tell the user in text once; do not retry in a loop.
