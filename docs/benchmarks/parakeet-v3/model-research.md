# Model selection, checked 2026-10-29

Searched Hugging Face's current NVIDIA Parakeet listings and model cards, including
newer Nemotron-branded successors. The listing snapshot is saved in
`huggingface-model-list.json`; last-modified dates may indicate documentation or
export changes rather than a new trained model.

| Candidate | English + Dutch | Suitability here |
|---|---|---|
| [Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) | Yes, 25 languages, automatic selection | Recommended practical Parakeet candidate; full-utterance TDT fits push-to-talk, official 714MB Q8 GGUF works on CPU and Vulkan, CC BY 4.0. Original release August 2025. |
| [Parakeet TDT 0.6B v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) | English only | Exclude for a single English/Dutch backend. |
| [Parakeet Unified English 0.6B](https://huggingface.co/nvidia/parakeet-unified-en-0.6b) | English only | Newer architecture does not satisfy Dutch. |
| [Parakeet CTC 1.1B](https://huggingface.co/nvidia/parakeet-ctc-1.1b) | English only | Larger and does not meet the language requirement. |
| [Nemotron 3.5 ASR Streaming 0.6B](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b) | Yes, automatic language mode | Native GGUF runtime available; cache-aware RNNT is relevant if live partial recognition becomes a requirement. Not benchmarked in this experiment. OpenMDW 1.1. |
| [Nemotron Labs Unified ASR 0.6B](https://huggingface.co/nvidia/nemotron-labs-unified-asr-0.6b) | Yes, 25 languages, automatic mode available | New multilingual successor released October 27, 2026. Track for later: card documents NeMo, and the checked NeMo-Speech.cpp supported-model list does not establish support for this specific unified checkpoint. OpenMDW 1.1. |

The new Unified model reports better aggregate offline accuracy than v3, but its
published evaluation uses explicit target-language prompts. That is not proof of
an advantage on automatic-language short dictation, and no local inference was
run with it. Do not confuse the 0.6B ASR family with the much larger Nemotron 3.5
Transcribe 30B-A4B evaluated separately.

The v3 model card advertises punctuation/capitalization. The tested Q8/native path
actually returned lowercase unpunctuated transcripts, so the measured behavior,
not the headline capability, should guide integration decisions. The existing
sherpa-onnx v3 int8 export is another deployment option; this experiment uses the
official Q8 GGUF with native Vulkan to match the app's portable GPU direction.

Runtime sources:
[NeMo-Speech.cpp supported models](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/66d50d91b75a406becd95fbaf39d2c9c13e95d7c/README.md),
[ASR models and conversion](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/66d50d91b75a406becd95fbaf39d2c9c13e95d7c/docs/asr/models.md).
