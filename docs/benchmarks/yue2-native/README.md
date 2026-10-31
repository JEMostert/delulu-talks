# YuE2, native: parity and performance

Delulu FM's music engine (`crates/music`, the `delulu-music` helper) runs YuE2 3B in
Rust on ggml (Vulkan, CPU fallback). It reads ComfyUI's INT8 ConvRot checkpoint
(`yue2_3b_int8_convrot.safetensors`, Comfy-Org/YuE2 at revision `2f76ca75`) without
requantizing: each INT8 row becomes Q8_0 blocks with unit scale, the row scale is
applied after the product, and activations get the 256-wide Hadamard rotation in the
graph. The pipeline follows ComfyUI's YuE2 text-to-music template: ABC score, music
tokens, the language model's keys and values as conditioning, 32 `dpm_2` /
`sgm_uniform` flow steps with CFG 1, and the Oobleck VAE.

## Parity (2026-10-31, RTX 5060 Ti, Vulkan)

Same inputs through each implementation: the prompt prefix (86 tokens), a 571-token
score prefix with 100 music tokens, one noise tensor, and the resulting latent.
`ref.py` runs ComfyUI's own code (bf16, W8A8 kernels); `ref32.py` runs the same
modules on the CPU with every INT8 weight dequantized to FP32, as ground truth;
`crates/music/examples/parity.rs` runs single native stages; `compare.py` prints:

```
vs FP32 ground truth
ComfyUI LM logits                            cosine 1.00000  SNR  50.2 dB
native  LM logits                            cosine 1.00000  SNR  64.5 dB
ComfyUI DiT velocity t=1.0                   cosine 0.99984  SNR  34.9 dB
native  DiT velocity t=1.0                   cosine 1.00000  SNR  59.2 dB
ComfyUI DiT velocity t=0.5                   cosine 0.99917  SNR  27.8 dB
native  DiT velocity t=0.5                   cosine 1.00000  SNR  53.1 dB
native vs ComfyUI
32-step dpm_2 latent, same noise             cosine 0.99994  SNR  39.2 dB
VAE audio, same latent                       cosine 1.00000  SNR  51.9 dB
```

The native engine is closer to the FP32 model than ComfyUI is. Every matrix product
asks for F32 accumulation: with Vulkan's default (F16 accumulation on this card) the
LM logits were only 24.6 dB from FP32.

Token sampling uses its own random generator, so a given seed does not reproduce
ComfyUI's song; the filters (allowed tokens, minimum length, windowed repetition
penalty, temperature, top-k, top-p) and their settings match ComfyUI's.

## A real song

Style "melancholic synth-pop ballad, slow tempo, soft male vocals…", 26 lines of
lyrics, up to 180 s, seed 7:

| | |
|---|---|
| Score | 1209 ABC tokens (2/4, 70 BPM, Bb, Bb–Gm–Eb–Fsus4–F), 19.7 s |
| Music tokens | 3946 (2:38, ended on its own), 65.1 s |
| Model loads | 4.5 s total (language model, acoustic model, VAE, one at a time) |
| Shaping | 63 acoustic passes, 73.9 s |
| VAE | 3.1 s |
| Wall clock | 2:47 for 2:38 of audio |
| Peak graphics memory | 3.65 GB (driver free-memory delta) |
| Peak RAM | 1.08 GB (max RSS) |

Whisper large-v3-turbo transcribed the result as the requested lyrics ("Are you still
awake? … The last bus folds its doors at two / I keep the ticket in my coat / Your
voice still sounding like the news … One light left on the avenue … Maybe it's the
rain"), with the usual Whisper repetitions in instrumental stretches.

An uncontended language-model step takes about 13 ms (77 tokens/s; ComfyUI's CUDA
graphs reach 68 tokens/s on the same card). Steps slow down when other programs use
the card.

## Reproduce

```sh
bun run build:music
cargo build --release -p delulu-music --example parity
# ref.py / ref32.py import ComfyUI read-only from ~/comfy/ComfyUI; run them with
# ComfyUI's Python. Then run parity.rs (lm, dit, sample, vae) on the files they wrote
# and compare.py in the same folder.
```
