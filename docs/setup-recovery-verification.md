# Setup recovery verification

The former installer subprocess suite and its synthetic Python executable have been removed. The focused check is:

```sh
cargo test -p delulu-runtime
```

It checks that a failed setup keeps the active generation and logs the attempt, that cancellation terminates the running command, that inventory comes from the candidate environment and that Python overrides cannot redirect setup. The Electron `runtimeSafety.test.ts` cases for legacy-installation rollback, malformed generation targets and ordered model-operation recovery are not ported yet. Temporary records are isolated from actual runtimes; no packages or model downloads are started.

Installer process cancellation and native readiness still need manual acceptance when changing installation code. The unit suite establishes pointer and queue safety, not native MLX/CUDA readiness. See [testing](VERIFICATION.md) for the current suite policy.
