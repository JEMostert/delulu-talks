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

Owners: [installer](../../electron/runtime/installer.ts), [runtime inventory](../../electron/runtime/inventory.ts), [manifest](../../electron/runtime/manifest.ts), [ASR lifecycle](../../electron/services/asr.ts), [storage paths](../../electron/services/storage.ts), [package resources](../../electron-builder.yml). See [runtime inventory](../runtime-inventory.md).
