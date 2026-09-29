# ADR 0002: one speech model, platform-specific execution backends

Status: accepted catalog policy; native Mac/Windows inference acceptance pending. Recorded 30 September 2026.

## Context

The preferred recognition model is Confucius4-R2T2. CUDA is an execution backend, not an intrinsic property of the fine-tuned weights. Native Windows cannot use the same vLLM installation as the Linux reference, and replacing the Mac model with smaller base Qwen changes recognition behavior.

## Decision

Offer R2T2 as the only active speech model. Native Apple Silicon selects the direct BF16 MLX conversion; Linux CUDA keeps vLLM; Windows CUDA uses the native PyTorch/Transformers adapter. Intel/Rosetta Mac execution is unsupported. Optional Qwen 3.5 rewriting has its own catalog and lifecycle; it is not an alternative speech selection. Other speech models belong only in explicitly external benchmark comparisons.

Current application IDs are `r2t2` and `r2t2Mlx`; the latter still encodes a backend choice. Reports distinguish the generic R2T2 model identity, backend, checkpoint/runtime revision, precision, and supplied hardware provenance. A future fully separate model/backend capability schema is not implemented by this decision.

Historical Qwen history attribution remains historical. Settings migration may select the new platform model, but old records are not relabeled as R2T2 observations.

## Consequences and alternatives

Platform-specific adapters and decoder contracts are maintained independently, while the product keeps a familiar speech identity. A single vLLM dependency graph across all desktops and automatic substitution with base Qwen are rejected. Exact pinned revisions and conversion provenance are shown where actually available; unpinned routes are labeled rather than treated as reproducible snapshots.

Mocked contracts and the static MLX weight audit do not establish native recognition quality, warmup, allocator release, memory minimum, or permission/paste behavior. Mac/Windows acceptance remains a hardware gate.

Owners: [platform selection](../../electron/runtime/platform.ts), [catalog](../../src/data.ts), [MLX adapter](../../electron/python/metal_speech.py), [Windows adapter](../../electron/python/windows_speech.py), [Linux worker](../../electron/python/transcription_engine.py). See [model provenance](../model-provenance.md), [Mac support](../MAC_SUPPORT.md), and [Windows support](../WINDOWS_SUPPORT.md).
