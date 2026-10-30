---
name: delulu-speak
description: Speak concise agent replies aloud when the user requests spoken output or during an active voice conversation. Use for completion reports, answers, or a blocking question; do not activate for ordinary text-only work or microphone/listening control.
---

Speak one to three short sentences, summarizing the outcome or decision. Keep code, logs, long lists, and the full written answer in text. Avoid repeated progress announcements.

```sh
delulu speak 'Done. The fix is ready for review.'
printf '%s' 'The build passed. One decision remains.' | delulu speak
```

The command waits until playback ends. Cancel its process to stop speech. Jobs queue automatically; no server or desktop app is required. If it fails, continue in text and report the error once; run `delulu setup` when configuration is missing. If weights are absent, explain that `delulu install-model` downloads an optional model of about 3 GB; install it only when the user opts in.

For an existing Delulu listening session using `delulu-voice`, keep that session's `say`/response-id and interruption flow; do not speak the same reply through both paths. This skill never starts or changes microphone capture.
