/** Direct versions match the reference machine's installed runtime (September 2026).
 * Linux transitive constraints live beside the Python worker. Portable platforms
 * share direct pins; their platform-specific wheels are resolved by pip.
 */
export const RUNTIME_REVISION = "2026-09-20.1";
export const INSTALLER_PACKAGES = [
  "pip==26.2.1",
  "wheel==0.47.0",
  "setuptools==84.0.0",
];
export const SPEECH_PACKAGES = [
  "git+https://github.com/netease-youdao/Confucius4-R2T2.git@80c22e6140bcb9166fb9906798894fc8b18c8309",
];
// Matched stable core/plugin wheels, following upstream's release installer.
export const METAL_PACKAGES = [
  "https://github.com/vllm-project/vllm/releases/download/v0.29.0/vllm-0.29.0%2Bcpu-cp312-cp312-macosx_11_0_arm64.whl",
  "vllm-metal[stt] @ https://github.com/vllm-project/vllm-metal/releases/download/v0.29.0/vllm_metal-0.29.0-cp312-cp312-macosx_15_0_arm64.whl",
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
