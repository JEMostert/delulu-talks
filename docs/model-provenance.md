# Model download provenance

The model cards' Details → “source, revision & license” exposes the configured repository,
download revision policy, conversion attribution and upstream weight license.
The disclosure is available beside speech and the currently selected optional
rewrite model. These are configuration details, not an inspection of a resident
model or a claim that native inference has passed. Already cached, floating
upstream downloads may resolve to different snapshots.

| Model / backend             | Download source and revision                                                                                                                                                              | Conversion                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R2T2, Linux CUDA            | [Original R2T2 snapshot](https://huggingface.co/netease-youdao/Confucius4-R2T2/tree/185ce639118ad1362d049ca0d8ed04b6ec5cd6c9), `185ce639118ad1362d049ca0d8ed04b6ec5cd6c9`                 | [Delulu's adapter](../backend/python/r2t2_checkpoint.py) applies the official Transformers key/config mappings with strict weight loading. Cache generation: `transformers-5.15.0-v1`.                                                                                                                                                                                                           |
| R2T2, Apple Silicon MLX     | [mlx-community/Confucius4-R2T2-bf16](https://huggingface.co/mlx-community/Confucius4-R2T2-bf16/tree/747f5fc5f84bc9976baa2f02714e2fed67ed8611), `747f5fc5f84bc9976baa2f02714e2fed67ed8611` | Published unquantized BF16 conversion of the original R2T2 checkpoint. The [pinned publisher card](https://huggingface.co/mlx-community/Confucius4-R2T2-bf16/blob/747f5fc5f84bc9976baa2f02714e2fed67ed8611/README.md) records `mlx_audio.convert`, xocialize/mlx-audio fork `1792021`, MLX `0.32.2`, Apple M5 Max. Conversion tool versions differ from the app's pinned inference dependencies. |
| Pilot 0.8B                  | [Qwen/Qwen3.5-0.8B](https://huggingface.co/Qwen/Qwen3.5-0.8B/tree/2fc06364715b967f1860aea9cf38778875588b17), `2fc06364715b967f1860aea9cf38778875588b17`                                   | Original checkpoint, loaded through Transformers; no Delulu format conversion.                                                                                                                                                                                                                                                                                                                   |
| Optional rewrite 2B         | [Qwen/Qwen3.5-2B](https://huggingface.co/Qwen/Qwen3.5-2B/tree/15852e8c16360a2fea060d615a32b45270f8a8fc), `15852e8c16360a2fea060d615a32b45270f8a8fc`                                       | Original checkpoint, loaded through Transformers; no Delulu format conversion.                                                                                                                                                                                                                                                                                                                   |
| Optional rewrite Phi-4 mini | [microsoft/Phi-4-mini-instruct](https://huggingface.co/microsoft/Phi-4-mini-instruct/tree/cfbefacb99257ffa30c83adab238a50856ac3083), `cfbefacb99257ffa30c83adab238a50856ac3083`           | Original checkpoint, loaded through Transformers; no Delulu format conversion.                                                                                                                                                                                                                                                                                                                   |

All original and converted R2T2 weights remain subject to the
[NetEase Youdao Model Use License Agreement](https://github.com/netease-youdao/Confucius4-R2T2/blob/master/MODEL_LICENSE),
linked by the upstream model cards. The MLX conversion does not replace that
license with the app's code license. The Qwen models publish their own Apache 2.0
weight licenses ([0.8B](https://huggingface.co/Qwen/Qwen3.5-0.8B/blob/main/LICENSE),
[2B](https://huggingface.co/Qwen/Qwen3.5-2B/blob/main/LICENSE)); Phi-4 mini uses the
[MIT license](https://huggingface.co/microsoft/Phi-4-mini-instruct/blob/main/LICENSE).

R2T2 upstream cards and license targets were checked on 29 September 2026
without model downloads. These are metadata, not native inference evidence; see
[Mac support](MAC_SUPPORT.md) and [model research](MODEL_RESEARCH.md).
