# Runtime consolidation: implementation and remaining gates

This pass integrates PRs 420, 424, 427, 446, 447, 466, 470, 474 and 489 into the current extracted IPC architecture. It is UNVERIFIED: no tests, builds, typechecks, benchmarks, installation, downloads or native inference were run.

Speech remains R2T2 only. The stored platform selection keys `r2t2` and `r2t2Mlx` refer to one identity; execution metadata records the adapter, actual reported precision and pinned checkpoint separately. Historical Qwen speech records remain readable without creating an active Qwen speech selection. Qwen3.5 rewriting owns a separate runtime, package environment and generated-code caches.

Setup prepares an isolated candidate without switching the durable runtime pointer. Speech setup requires completed backend warmup. Writing setup performs a bounded, fixed internal inference and discards its output before verifying warmup and activating the candidate. Cancellation suppresses old progress/results, stops setup processes and its worker, and discards only the candidate selection. Child/process-tree and GPU memory release still need native validation on each platform; termination timeouts are not physical memory evidence.

The Linux readiness probe and worker use `r2t2.R2T2ASRModel`, matching the [example at the exact installed upstream source revision](https://github.com/netease-youdao/Confucius4-R2T2/blob/80c22e6140bcb9166fb9906798894fc8b18c8309/example.py). They do not import the earlier `qwen_asr` API. Speech downloads continue through immutable-revision/hash verification, with byte counters emitted by the actual verified transfer loop. Reused/resumed bytes can contribute to the current file's completion counter; this is not a measure of newly transferred network bytes or aggregate installation progress.

## Acoustic streaming gap (#94, #96, #97, #98, #101, #104)

The [upstream R2T2 API](https://github.com/netease-youdao/Confucius4-R2T2#python-api) accepts incremental audio with `init_streaming_state`, `streaming_transcribe` and `finish_streaming_transcribe`. This establishes feasibility for its Linux vLLM adapter, but does not establish compatibility with the app's Windows converted Transformers adapter or MLX adapter.

MLX Audio's [current Qwen-ASR implementation](https://github.com/Blaizzy/mlx-audio/blob/main/mlx_audio/stt/models/qwen3_asr/qwen3_asr.py) exposes token output from already supplied audio. That source is newer than the pinned package and is not proof of an incremental microphone API, R2T2 committed-prefix behavior or native performance. It must not be advertised as acoustic streaming.

The app's production Python command loop dispatches one operation synchronously. Its capture path retains whole recordings. The bounded chunk/session contract exists, but has no attached worker command/event transport, inference session owner or microphone integration. Implementing only an upstream decode loop would leave cancellation, late-generation suppression, receiver credit/backpressure and final-drain behavior incomplete.

A complete implementation needs an independently cancellable inference owner; bounded ordered PCM admission; generation/session-tagged validated transcript events; monotonic committed-prefix enforcement; explicit finalization and backend flushing; renderer partial display separated from final history/paste; and original-audio fallback after timeout/overflow/worker failure. Windows/MLX require actual incremental adapter support rather than independent file-window transcripts joined together. Consequently capabilities remain `streaming: false` and reserved stream commands reject explicitly. There is no placeholder activation or generated-token streaming substitute in this consolidation.

Native evidence is still required for accuracy, stable prefixes, latency, buffering under sustained capture, cancellation/process cleanup, CUDA/Metal memory release, checkpoint conversion and cold/offline setup. Buffered transcription remains the default while these code and evidence gates are unresolved.
