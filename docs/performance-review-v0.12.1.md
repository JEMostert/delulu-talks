# Performance and reliability review — v0.12.1

The review followed capture from the renderer through IPC, worker dispatch, live inference, delivery and saved history. It also inspected renderer subscriptions, lazy pages, runtime cleanup, queue persistence, packaging and release verification. Existing boundaries around sandboxed IPC, original transcript preservation and atomic storage remain useful; the changes address observed repeated work and faulty lifecycle paths.

| Area | Finding | Implemented change |
| --- | --- | --- |
| Worker contract | Desktop validation rejected streaming commands, and did not accept Nemotron capability metadata. | Align TypeScript validation with the existing Python protocol, retaining request and response limits. |
| Live audio | Promise closures could queue an entire recording behind slow inference. | One draining queue, at most 25 waiting chunks and 4 MiB of encoded PCM. Excess backlog stops live delivery and uses the complete recording. |
| Python buffers | Each append copied all prior audio; already processed audio remained retained. | Reusable storage with absolute sample offsets. Release processed phrases and retain only overlapping native windows. Native unread audio is limited to 30 seconds. |
| Live delivery | Spacing excluded the current paste; a rejected first paste could have inserted characters before fallback. | Include in-flight text in spacing and treat any attempted live paste as requiring clipboard-only fallback. |
| Session cleanup | Old cancellation could finish a newer session; short recordings left streams open. | Own cleanup until decoder and paste promises settle, block new capture during cleanup and close discarded captures. |
| Decoder termination | Joining native decoder threads could return success despite a still-running decoder. | A shared finish deadline with thread liveness checks; failed finishing stops the worker before fallback reload. |
| Renderer Stop | Sinc resampling and WAV encoding blocked the interface. | A short-lived local encoding worker; release capture first, retain input for startup failure fallback and terminate on cancellation. |
| Renderer updates | Clock ticks rendered the whole workspace; list previews were rebuilt repeatedly. | Isolated clock labels with monotonic time, deferred search and memoized bounded list previews. |
| Software animations | The scheduler woke every 45 ms even while hidden and manually advanced covered motes. | Schedule at the actual update cadence, hold covered motes and suspend scheduling when hidden or reduced motion is enabled. |
| Import persistence | Rollback replaced the running job object while its runner still held the old object. | Preserve active-job identity during rollback so the settled state reaches the queue. |
| Desktop cleanup | KDE clipboard calls had no deadline; installer escalation was cancelled as soon as the parent exited. | Bound clipboard publication to two seconds and preserve escalation for the old installer process group. |
| Data inspection | Spreading a huge directory into the pending stack could fail before the visit budget applied. | Bound scheduling to the remaining scan budget and report partial totals. |
| Distribution | Python resources are enumerated individually. | Bundle and checksum the new stream buffer explicitly on every platform. |

The worker encoder keeps the original chunks until it succeeds, so it temporarily holds an additional copy in its own thread. This trades transient memory for responsiveness and recovery. The complete recording is still retained for buffered fallback; the smaller live buffer does not reduce the recording's fidelity.

The existing ten-minute resampling unit completed in approximately 0.7 seconds locally. The algorithm is unchanged; the optimization moves that computation away from the interface thread. No overall latency percentage or hardware-independent speedup is claimed.

Validation used the existing suites: 70 TypeScript units, 19 Python units, two Chromium capture workflows, formatting, typechecking, Python compilation and production build. Browser interaction verified search matches across source layers, file filtering, draft retention across page navigation and compact layout without horizontal overflow. Screenshots were inspected. Unit and browser verification do not establish real GPU inference, platform microphone behavior or native paste; the running installed speech worker was left undisturbed.
