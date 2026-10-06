# Third-party notices

## Hugging Face Transformers Qwen3-ASR conversion helpers

`electron/python/r2t2_checkpoint.py` contains helpers adapted from Hugging Face Transformers' `convert_qwen3_asr_to_hf.py` at commit `f4410762062c274fb53471e551e62b377df44cc1`.

Copyright 2026 The HuggingFace Inc. team. All rights reserved.

Source: [upstream conversion script](https://github.com/huggingface/transformers/blob/f4410762062c274fb53471e551e62b377df44cc1/src/transformers/models/qwen3_asr/convert_qwen3_asr_to_hf.py).

License: Apache License, Version 2.0. The full [license text](licenses/transformers-Apache-2.0.txt) was copied without alteration from the [upstream repository license at that commit](https://github.com/huggingface/transformers/blob/f4410762062c274fb53471e551e62b377df44cc1/LICENSE).

Delulu Talks extracts the ASR weight-key mapping, configuration cleanup, and chat-template helpers into a small runtime module. The upstream conversion CLI and unrelated conversion workflows are omitted. The Windows adapter uses these helpers to retain the original R2T2 weights while loading the native Transformers architecture.

The Apache-2.0 code license is separate from the R2T2 checkpoint's weight license. The application does not bundle model weights.

## Experimental Parakeet Redux CPU model

The optional CPU adapter uses Moondream's Parakeet Redux checkpoint, derived from NVIDIA Parakeet TDT v3, at revision `2bf128600aac4b16946f7ed8372e56117fe5e23b`. The weights are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); attribution and the upstream license are available in the [model repository](https://huggingface.co/moondream/parakeet-redux). Weights are downloaded separately and are not bundled with Delulu Talks. See [setup and validation limits](PARAKEET_REDUX_CPU.md).
