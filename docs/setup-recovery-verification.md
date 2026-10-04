# Setup recovery verification

The former installer subprocess suite and its synthetic Python executable have been removed. The focused replacement is:

```sh
bun test electron/runtime/runtimeSafety.test.ts
```

It checks activation/rollback to previous and legacy installations, rejection of malformed generation targets without overwriting the selected runtime, and ordered model-operation recovery after a rejection. Temporary activation records are isolated from actual runtimes; no packages, model downloads or worker processes are started.

Installer process cancellation and native readiness still need manual acceptance when changing installation code. The unit suite establishes pointer and queue safety, not native MLX/CUDA readiness. See [testing](VERIFICATION.md) for the current suite policy.
