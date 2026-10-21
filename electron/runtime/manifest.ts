/** Direct versions match the reference machine's installed runtime (September 2026).
 * Linux transitive constraints live beside the Python worker. Portable platforms
 * share direct pins; their platform-specific wheels are resolved by pip.
 */
export const RUNTIME_REVISION = "2026-10-18.1";
export const INSTALLER_PACKAGES = [
  "pip==26.2.1",
  "wheel==0.47.0",
  "setuptools==84.0.0",
];
// Direct MLX inference keeps the R2T2 fine-tune on Apple Silicon.
// MLX Audio API inspected at this exact source revision; native validation pending.
export const METAL_PACKAGES = [
  "mlx==0.32.2",
  "mlx-audio[stt]==0.5.7",
  "transformers==5.15.0",
];
export const WINDOWS_CUDA_PACKAGES = [
  "torch==2.13.0+cu130",
  "torchvision==0.28.0+cu130",
];
// Linux PyPI wheels of torch already bundle CUDA.
export const LINUX_CUDA_PACKAGES = ["torch==2.13.0", "torchvision==0.28.0"];
// R2T2 runs on Transformers; no serving engine reserves VRAM.
export const SPEECH_PACKAGES = [
  "transformers==5.15.0",
  "accelerate==1.14.0",
  "safetensors==0.8.0",
  "soundfile==0.13.1",
  "librosa==0.11.0",
  "soxr==1.0.0",
  "sentencepiece==0.2.2",
];
export const MAGIC_PACKAGES = [
  "torch==2.13.0",
  "torchvision==0.28.0",
  "transformers==5.15.0",
  "accelerate==1.14.0",
  "safetensors==0.8.0",
  "sentencepiece==0.2.2",
  "pillow==12.3.0",
];
// Voice (text-to-speech) has its own runtime. Kokoro (Small) needs only
// sherpa-onnx on the CPU; Chatterbox Turbo (Large) adds PyTorch. torchaudio
// stopped at 2.11, so the voice runtime pins torch 2.11 independently of the
// speech and rewrite runtimes. Verified on Linux x64, CUDA 13, sm_120.
export const VOICE_CPU_PACKAGES = [
  "sherpa-onnx==1.13.8",
  "soundfile==0.13.1",
  "soxr==1.0.0",
  "huggingface-hub==1.33.0",
];
export const VOICE_TORCH_PACKAGES = ["torch==2.11.0", "torchaudio==2.11.0"];
export const VOICE_WINDOWS_TORCH_PACKAGES = [
  "torch==2.11.0+cu130",
  "torchaudio==2.11.0+cu130",
];
export const VOICE_GPU_PACKAGES = [
  "transformers==5.15.0",
  "safetensors==0.8.0",
  "librosa==0.11.0",
  "s3tokenizer==0.3.0",
  "diffusers==0.29.0",
  "conformer==0.3.2",
  "resemble-perth==1.0.1",
  "omegaconf==2.4.0",
  "pyloudnorm==0.2.0",
];
// chatterbox-tts pins torch 2.6 (no Blackwell support), Gradio and other
// demo dependencies. Install it without dependencies; the packages above are
// what Turbo inference imports.
export const VOICE_UNPINNED_PACKAGES = ["chatterbox-tts==0.1.7"];
/** `pip check` lines starting with these are expected and accepted. */
export const VOICE_PIP_CHECK_EXCEPTIONS = ["chatterbox-tts 0.1.7 "];
// Small (Canary) and Medium (Parakeet) run on the CPU through sherpa-onnx, which
// bundles ONNX Runtime. These are the whole speech runtime unless Large is
// chosen; the R2T2 runtime includes them too, so switching down needs no setup.
// huggingface-hub matches the version Transformers resolves for R2T2.
export const CPU_SPEECH_PACKAGES = [
  "sherpa-onnx==1.13.8",
  "soundfile==0.13.1",
  "soxr==1.0.0",
  "huggingface-hub==1.33.0",
];
