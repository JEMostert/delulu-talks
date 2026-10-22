# ADR 0003: package adapters, install isolated runtime generations

Status: accepted runtime packaging strategy. Recorded 30 September 2026.

## Context

Speech and rewriting have independent dependency graphs even when their direct Transformers versions coincide. Python/GPU environments and downloaded weights are large, user-owned local state. Replacing the Electron application must not require discarding a working runtime or personal history.

## Decision

Bundle the Python workers/adapters, applicable constraints, notices, and native app assets as Electron resources. Install Python environments outside the app bundle, under the application data directory. Speech and writing use distinct environment roots and worker processes. Legacy `asr-venv` may remain the writing root when preserving an existing installation; it is not reused as the new speech environment.

Runtime setup is serialized. Candidates live in generation directories; interpreter compatibility, installation, `pip check`, required imports, and observed dependency inventories precede activation. The active pointer selects a generation. The ASR service owns model load/warmup and setup rollback integration; the installer owns generation creation, validation, activation records, and its own cleanup. Resetting a runtime does not reset settings/history or the shared model cache.

Direct pins and platform constraints are packaging inputs, not a universal artifact hash lock. The inventory records observed distributions/dependencies and execution stages. It does not independently attest checkpoint identity, wheel authenticity, recognition quality, or actual GPU execution.

## Consequences and alternatives

This duplicates some dependencies and can consume substantial disk and physical GPU/unified memory, but a writing dependency upgrade does not replace the speech environment. A single environment just because direct versions match, bundling all weights in each app package, and in-place destructive repair are rejected.

Final cross-backend preload restoration, uncooperative installer descendants, crash/power-loss durability, and artifact hash verification need their own failure-path work. Recording this architecture does not assert that every rollback or native packaging gate has passed. Native Mac/Windows acceptance remains separate.

Owners (since ADR 0006): [installer](../../src-tauri/crates/delulu-runtime/src/installer.rs), [runtime inventory](../../src-tauri/crates/delulu-runtime/src/inventory.rs), [manifest](../../src-tauri/crates/delulu-runtime/src/manifest.rs), [ASR lifecycle](../../src-tauri/crates/delulu-speech/src/asr.rs), [profile paths](../../src-tauri/crates/delulu-core/src/paths.rs), [package resources](../../src-tauri/tauri.conf.json). See [runtime inventory](../runtime-inventory.md).

## Amendment (v0.1.0, ADR 0006)

The workers and adapters are now Tauri bundle resources (`bundle.resources` in `src-tauri/tauri.conf.json`) instead of Electron resources. Environments stay in the same profile directory, so runtimes installed by Electron releases remain usable. See [ADR 0006](0006-tauri-and-native-audio.md).
