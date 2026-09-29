# Model lifecycle reporting

Speech and optional writing publish independent model residency, backend-reported device, warmup state and scheduled idle-check timestamp alongside their operation phase. Recording/transcribing/rewriting is an activity; it does not itself imply loaded weights or a completed warmup. Models shows these four fields separately.

Loaded backend status reports resident weights and its observed device. Speech warmup completes only after the existing inference warmup succeeds. Writing load only initializes weights: warmup stays not-started until a successful generation exercises inference. Failure/shutdown/unload reset or mark uncertain state unknown as appropriate. Missing lifecycle fields remain not-reported instead of inferring hardware from a model catalog label. Resident state does not measure GPU memory or prove it has been released on a particular machine.

The idle timestamp is the next scheduled ownership check, not a promise of unloading at that instant. Current capture, inference, maintenance and the latest keep-loaded preference can defer or cancel it; the next reported timestamp follows the actual timer. Lifecycle metadata remains local and contains no additional transcript content.

This implementation is UNVERIFIED. Tests, builds, typechecks, formatting, browser/desktop checks, packaging and native MLX/CUDA inference were skipped per the user instruction. Independent recovery correction #324 and the worker protocol stack remain queued for later integration/verification; no hardware claims are made from this source change.
