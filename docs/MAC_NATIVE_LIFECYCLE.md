# Mac lifecycle and offline scenarios

This is executable opt-in validation code for issues34/35, not recorded native evidence. It is stacked on the shared native inference harness. No scenario has been run while authoring it.

```sh
bun scripts/mac-native-lifecycle.mjs --run \
  --python "/existing/native-arm64/runtime/bin/python" \
  --cache "/copied/pre-downloaded/models" \
  --audio "/consented/speech.wav" --language en \
  --retained-limit-mib 64 --output "/new/mac-lifecycle.json"
```

The Mac-only driver runs ten actual load/transcribe/unload cycles. An isolated worker bootstrap observes available MLX active/peak/cache allocation APIs from the model-owning process. Missing active-memory support fails memory acceptance instead of inventing a measurement. The post-unload limit is explicit and included in the report; it measures MLX allocations, not system-wide GPU use or returned physical memory. Native worker PIDs are checked after bounded shutdown, then a fresh worker loads and transcribes the same hashed input against cached weights.

The bootstrap blocks external Python socket DNS/TCP/UDP operations and records attempted endpoints/counts; Unix sockets and loopback remain available. Child offline flags are set, and FFmpeg conversion accepts local file/pipe protocols only. No runtime installation or model download is invoked. This guard is not an OS sandbox: native libraries/subprocesses are outside Python socket interception. Physically disconnect networking on the owner's Mac for the final offline acceptance run. Full native Electron restart, native app installation and other-app delivery are separate pending checks.

Production Python source is unchanged; the bootstrap loads the explicitly selected source/packaged worker and records its hashes plus the observation script hash. Source audio remains unchanged, converted audio and journals live in owned temporary directories, and reports omit transcript text. Use a copied cache and keep the daily app/GPU inference idle. MLX conversion can write to that opted-in cache. Every scenario report reflects its actual future outcome and retains partial observations on failure.
