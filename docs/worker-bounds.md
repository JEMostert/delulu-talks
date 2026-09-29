# Worker protocol bounds

Speech (R2T2) and optional writing (Qwen 3.5) use independent `WorkerClient` instances. Audio is sent as a file path; transport requests contain metadata and text, not encoded audio. These limits bound transport buffering and admission, and do not imply acoustic streaming or a bound on GPU/model memory.

| Resource | Per-worker limit | Overflow behavior |
| --- | --- | --- |
| Serialized request | 4 MiB UTF-8, excluding LF | Reject before spawning, assigning a pending entry or writing any bytes. Existing requests continue. |
| Pending requests | 8 | Reject only the additional request. Completion, stop or failure releases slots. |
| Stdout line | 8 MiB UTF-8, including protocol/progress prefix and excluding LF/CRLF | Stop the generation once and reject all its pending work. This also applies to ordinary logs and unterminated lines. Explicit Load/retry starts a new generation. |
| Retained stderr | 80,000 UTF-8 bytes | Retain the newest valid text without splitting Unicode or letting replacement characters exceed the budget. |
| Progress callback | Last 350 string characters | Bound visible detail after enforcing the stdout line limit. |

The versioned request envelope preserves its generated ID, command and protocolVersion; [protocol version 1](worker-protocol.md) validates command payloads and terminal results at both ends. Cycles, unsupported JSON values, envelope-altering `toJSON`, invalid timeouts and excessive serialized bytes reject locally; they cannot strand a request or stop healthy accepted work. A bounded growable byte buffer frames stdout across arbitrary chunks, handles split Unicode/CRLF and the final EOF line, and releases response slots by ID. Output buffered from a stopped generation cannot resolve, fail or report progress for a replacement worker.

The Python entrypoint independently caps binary input before JSON parsing, including input without a newline. A request over 4 MiB exits with an actionable diagnostic and no dispatch or partial response; the desktop failure handler requires intentional recovery. The emitter assembles a prefixed response within 8 MiB before writing stdout. An oversized result produces a short request-local rejection and leaves subsequent requests usable. Exception messages are limited to 8,000 UTF-8 bytes; stderr still records stack locations. Original audio, settings, history and model runtimes are not deleted on transport rejection.

`bun test electron/runtime/workerClient.test.ts electron/runtime/workerProtocol.test.ts` exercises real synthetic Python subprocesses and framing/serialization helpers: exact and excessive UTF-8 boundaries, queued admission/release, nonserializable input, unterminated output, CRLF/EOF, ordinary logs, diagnostic tails and stale-generation isolation. `python3 -m unittest discover -s electron/python -p '*_test.py'` includes real entrypoint request overflow and fixture dispatch checks for bounded responses/errors and recovery. Tests use temporary processes/data, perform no model downloads or GPU inference, and do not establish Mac MLX or Windows/Linux CUDA hardware behavior.
