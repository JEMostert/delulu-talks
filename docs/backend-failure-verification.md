# Backend failure and explicit retry verification

Backend failures return an error for the current request. They never publish a
partial transcript or rewrite, and the worker does not automatically rerun the
operation. Repair the cause, then issue Load, Transcribe or Rewrite deliberately.
A failed model load must leave that engine unloaded with no retained partial
model, processor or loaded metadata; the other engine remains unchanged.

The dependency-free regression suite runs with:

```sh
python3 -m unittest discover -s electron/python -p '*_test.py'
```

Load tests inject failures before and after model assignment, including Linux
NumPy/sampling setup and rewrite model evaluation. Assertions check unloaded
status, cleared affected state, unchanged unrelated engine state, cleanup calls,
and an intentional successful retry. Cleanup errors preserve the original backend
cause. Inference tests inject preparation, generation and output decoding failures; they check that no result escapes and
that valid resident models can serve the next explicit request. Real JSON-lines
worker processes verify request IDs, error responses, subsequent status and retry.
CUDA/MPS/MLX allocator cleanup reuses already imported modules. Those calls are
best effort and do not evict the other engine. Native speech adapter tests use
simulated dependencies; no test downloads weights or requires CUDA/Metal.

The installed decoder probe uses a normally initialized lazy Worker before
selecting Linux and substituting recognition. This avoids bypassing worker
invariants. A unit contract checks its routing on three simulated host identities,
then a decoding failure followed by an explicit retry. Opt-in real decoder
verification is separate:

```sh
/path/to/prepared-speech-python scripts/decoder-contract.py --backend linux
```

Issue #229 integration evidence: all ten Linux installed-decoder fixtures passed
with Python 3.11.15, NumPy 2.3.5, SoundFile 0.13.1, soxr 1.0.0 and librosa 0.11.0.
The fixtures exercise mono/stereo WAV, resampling, FLAC/OGG, corrupt/empty/missing
input and source-byte preservation. Recognition is a stub, not GPU inference.
See [the decoder contract](decoder-contract.md) for tolerances and other backends.

These checks establish cleanup/control-flow and decoder behavior at the tested
seams. Mock allocator calls do not establish native allocation release or recovery
from a real CUDA/Metal/MPS fault. Native Mac/Windows speech and native rewriting
inference were not performed; use the platform smoke procedures on those machines.
A fatal GPU context or worker crash can still require a runtime restart.

The eleven focused backend-failure tests and two probe routing tests are also
included in CI Python discovery. Existing MLX/Windows adapter contracts remain
part of the complete suite.
