/** Direct versions match the reference machine's installed runtime (September 2026).
 * Linux transitive constraints live beside the Python worker. Portable platforms
 * share direct pins; their platform-specific wheels are resolved by pip.
 */
export const RUNTIME_REVISION = "2026-10-05.1";
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
// R2T2 and Nemotron both run on Transformers; no serving engine reserves VRAM.
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
