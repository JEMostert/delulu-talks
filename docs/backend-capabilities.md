# Backend capability negotiation

Before loading speech or writing, the desktop sends a versioned `capabilities` command for that engine to the same persistent worker. Python answers from its implemented adapter contract without importing model/GPU libraries or downloading weights. The desktop validates schema version, engine/model family, backend identity, feature booleans and the bounded unique language list. Models displays the negotiated report; stopped/failed workers clear it and a new load negotiates again.

Current buffered R2T2 adapters accept the explicit language hints already mapped by the application. They report timestamps, acoustic streaming and model vocabulary biasing unsupported because these controls are not implemented in the current worker pipeline. Optional Qwen 3.5 writing reports these speech controls unsupported. A request cannot silently turn on an unsupported control; invalid/unsupported fields reject before dispatch. Transcription checks its requested hint against the negotiated list before inference.

Capabilities describe accepted software controls, not hardware availability, model accuracy, calibrated timestamps or native platform validation. The backend name identifies the selected adapter and does not assert that its GPU/runtime has passed an owner-machine test. The R2T2-only speech and optional separate rewriting workflow remain.

UNVERIFIED: tests, builds, typechecks, formatting, browser/desktop checks, packaging and native inference were skipped per user instruction. Review and merge remain queued. This PR is stacked on the worker bounds/version/progress/lifecycle changes; future verification must integrate the separate deliberate-recovery correction #324.
