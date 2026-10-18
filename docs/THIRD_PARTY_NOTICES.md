# Third-party notices

## Hugging Face Transformers Qwen3-ASR conversion helpers

`electron/python/r2t2_checkpoint.py` contains helpers adapted from Hugging Face Transformers' `convert_qwen3_asr_to_hf.py` at commit `f4410762062c274fb53471e551e62b377df44cc1`.

Copyright 2026 The HuggingFace Inc. team. All rights reserved.

Source: [upstream conversion script](https://github.com/huggingface/transformers/blob/f4410762062c274fb53471e551e62b377df44cc1/src/transformers/models/qwen3_asr/convert_qwen3_asr_to_hf.py).

License: Apache License, Version 2.0. The full [license text](licenses/transformers-Apache-2.0.txt) was copied without alteration from the [upstream repository license at that commit](https://github.com/huggingface/transformers/blob/f4410762062c274fb53471e551e62b377df44cc1/LICENSE).

Delulu Talks extracts the ASR weight-key mapping, configuration cleanup, and chat-template helpers into a small runtime module. The upstream conversion CLI and unrelated conversion workflows are omitted. The Windows adapter uses these helpers to retain the original R2T2 weights while loading the native Transformers architecture.

The Apache-2.0 code license is separate from the R2T2 checkpoint's weight license. The application does not bundle model weights.

## Small and Medium CPU speech models

Small and Medium run NVIDIA [Canary 180M Flash](https://huggingface.co/nvidia/canary-180m-flash) and [Parakeet TDT 0.6B v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) / [v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3). The weights are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Delulu downloads the INT8 ONNX exports published by the sherpa-onnx project, pinned to these revisions:

- `csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8` at `9077164e0d3dd1d5353743e89ceaa1d3a770838c`
- `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8` at `1ab9323565ddb038682214b292f588070a538ce2`
- `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` at `2bda32ec70b097a55adaa07d9a7173915b43cc78`

Inference uses the [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) Python package (Apache License 2.0), installed into the speech runtime. Weights are downloaded separately and are not bundled with Delulu Talks.
