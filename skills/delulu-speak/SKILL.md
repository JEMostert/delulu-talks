---
name: delulu-speak
description: Speak concise agent replies aloud when the user requests spoken output or during an active voice conversation. Use for completion reports, answers, or a blocking question; do not activate for ordinary text-only work or microphone/listening control.
---

Speak one to three short sentences, summarizing the outcome or decision, in the language you are using with the user (Dutch and English both work; the language is detected per sentence). Keep code, logs, long lists, and the full written answer in text. Avoid repeated progress announcements.

```sh
delulu speak 'Done. The fix is ready for review.'
printf '%s' 'De build is geslaagd. Er staat nog één beslissing open.' | delulu speak
```

The command waits until playback ends. Cancel its process to stop speech. Jobs queue automatically; no desktop app is required. `--lang nl|en` fixes the language and `--voice F1…F5|M1…M5` picks a voice; leave both out normally. If it fails, continue in text and report the error once. If the voice model is missing, explain that `delulu install-model` downloads it (about 400 MB, OpenRAIL-M licence); install it only when the user opts in.

For an existing Delulu listening session using `delulu-voice`, keep that session's `say`/response-id and interruption flow; do not speak the same reply through both paths. This skill never starts or changes microphone capture.
