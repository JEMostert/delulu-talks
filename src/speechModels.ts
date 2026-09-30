/** Model identity is independent of the execution adapter or stored selection key. */
export type SpeechIdentity = "r2t2";
export type SpeechBackendId = "vllm-cuda" | "transformers-cuda" | "mlx-audio";
export type SpeechPrecision = "bf16" | "fp16" | "fp32";
export type SpeechExecution = {
  modelId: SpeechIdentity;
  backendId: SpeechBackendId;
  precision: SpeechPrecision | null;
  checkpoint: { repository: string; revision: string | null };
  platform: "linux" | "darwin" | "win32";
  device: "cuda" | "mlx";
};

export const SPEECH_IDENTITY = {
  id: "r2t2" as const,
  name: "R2T2",
  upstreamRepository: "netease-youdao/Confucius4-R2T2",
};

export const SPEECH_BACKENDS = [
  {
    id: "vllm-cuda" as const,
    label: "vLLM · CUDA",
    platform: "linux" as const,
    device: "cuda" as const,
    precisions: "Runtime automatic selection; actual precision may be unknown",
    checkpoint: { repository: SPEECH_IDENTITY.upstreamRepository, revision: "185ce639118ad1362d049ca0d8ed04b6ec5cd6c9" },
    capability: "Configured for Linux with NVIDIA CUDA; native acceptance pending",
  },
  {
    id: "transformers-cuda" as const,
    label: "Transformers · CUDA",
    platform: "win32" as const,
    device: "cuda" as const,
    precisions: "BF16 where supported, otherwise FP16",
    checkpoint: {
      repository: SPEECH_IDENTITY.upstreamRepository,
      revision: "185ce639118ad1362d049ca0d8ed04b6ec5cd6c9",
    },
    capability: "Configured for Windows with NVIDIA CUDA; native acceptance pending",
  },
  {
    id: "mlx-audio" as const,
    label: "MLX Audio · Metal",
    platform: "darwin" as const,
    device: "mlx" as const,
    precisions: "Unquantized BF16 checkpoint",
    checkpoint: {
      repository: "mlx-community/Confucius4-R2T2-bf16",
      revision: "747f5fc5f84bc9976baa2f02714e2fed67ed8611",
    },
    capability: "Configured for Apple Silicon, macOS 15+, native Python 3.12; native acceptance pending",
  },
];

export function speechBackendById(id: SpeechBackendId) {
  return SPEECH_BACKENDS.find((backend) => backend.id === id)!;
}

/** Accept reported historical facts, without upgrading them to today's pins. */
export function normalizeSpeechExecution(value: unknown): SpeechExecution | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const backend = SPEECH_BACKENDS.find((item) => item.id === source.backendId);
  if (!backend || source.modelId !== "r2t2" || source.platform !== backend.platform || source.device !== backend.device) return undefined;
  if (source.precision !== null && !["bf16", "fp16", "fp32"].includes(String(source.precision))) return undefined;
  const checkpoint = source.checkpoint;
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return undefined;
  const raw = checkpoint as Record<string, unknown>;
  if (raw.repository !== backend.checkpoint.repository) return undefined;
  if (raw.revision !== null && (typeof raw.revision !== "string" || !/^[a-f0-9]{40}$/i.test(raw.revision))) return undefined;
  return {
    modelId: "r2t2",
    backendId: backend.id,
    precision: source.precision as SpeechPrecision | null,
    checkpoint: { repository: raw.repository as string, revision: raw.revision as string | null },
    platform: backend.platform,
    device: backend.device,
  };
}
