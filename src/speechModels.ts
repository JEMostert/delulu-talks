/** Model identity is independent of the execution adapter or stored selection key.
 * Nemotron (removed in v0.13.0) and Parakeet Redux (removed in v0.16.0) stay only
 * to read older history records. */
export type SpeechIdentity =
  "r2t2" | "canary" | "parakeet" | "nemotron" | "redux";
/** Historical records may name vLLM; current runtimes never select it. */
export type SpeechBackendId =
  | "vllm-cuda"
  | "transformers-cuda"
  | "transformers-cpu"
  | "mlx-audio"
  | "onnx-cpu"
  | "photon-cpu";
export type SpeechPrecision = "bf16" | "fp16" | "fp32" | "int8";
export type SpeechExecution = {
  modelId: SpeechIdentity;
  backendId: SpeechBackendId;
  precision: SpeechPrecision | null;
  checkpoint: { repository: string; revision: string | null };
  platform: "linux" | "darwin" | "win32";
  device: "cuda" | "mlx" | "cpu";
};

export const SPEECH_IDENTITY = {
  id: "r2t2" as const,
  name: "R2T2",
  upstreamRepository: "netease-youdao/Confucius4-R2T2",
};

export const SPEECH_BACKENDS = [
  {
    id: "onnx-cpu" as const,
    label: "sherpa-onnx · CPU · INT8",
    platforms: ["linux", "darwin", "win32"] as const,
    device: "cpu" as const,
    models: ["canary", "parakeet"] as const,
  },
  {
    id: "photon-cpu" as const,
    label: "Photon · CPU · packed ternary (previous releases)",
    platforms: ["linux"] as const,
    device: "cpu" as const,
    models: ["redux"] as const,
  },
  {
    id: "vllm-cuda" as const,
    label: "vLLM · CUDA (previous releases)",
    platforms: ["linux"] as const,
    device: "cuda" as const,
    models: ["r2t2"] as const,
  },
  {
    id: "transformers-cuda" as const,
    label: "Transformers · CUDA",
    platforms: ["linux", "win32"] as const,
    device: "cuda" as const,
    models: ["r2t2", "nemotron"] as const,
  },
  {
    id: "transformers-cpu" as const,
    label: "Transformers · CPU (previous releases)",
    platforms: ["linux", "win32"] as const,
    device: "cpu" as const,
    models: ["nemotron"] as const,
  },
  {
    id: "mlx-audio" as const,
    label: "MLX Audio · Metal",
    platforms: ["darwin"] as const,
    device: "mlx" as const,
    models: ["r2t2"] as const,
  },
];

const REPOSITORIES: Record<SpeechIdentity, readonly string[]> = {
  r2t2: [
    SPEECH_IDENTITY.upstreamRepository,
    "mlx-community/Confucius4-R2T2-bf16",
  ],
  canary: ["csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8"],
  parakeet: [
    "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
  ],
  nemotron: ["nvidia/nemotron-3.5-asr-streaming-0.6b"],
  redux: ["moondream/parakeet-redux"],
};

export function speechBackendById(id: SpeechBackendId) {
  return SPEECH_BACKENDS.find((backend) => backend.id === id)!;
}

/** Accept reported historical facts, without upgrading them to today's pins. */
export function normalizeSpeechExecution(
  value: unknown,
): SpeechExecution | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const source = value as Record<string, unknown>;
  const backend = SPEECH_BACKENDS.find((item) => item.id === source.backendId);
  const modelId = source.modelId as SpeechIdentity;
  if (
    !backend ||
    !(backend.models as readonly string[]).includes(String(modelId)) ||
    !(backend.platforms as readonly string[]).includes(
      String(source.platform),
    ) ||
    source.device !== backend.device
  )
    return undefined;
  if (
    source.precision !== null &&
    !["bf16", "fp16", "fp32", "int8"].includes(String(source.precision))
  )
    return undefined;
  const checkpoint = source.checkpoint;
  if (
    !checkpoint ||
    typeof checkpoint !== "object" ||
    Array.isArray(checkpoint)
  )
    return undefined;
  const raw = checkpoint as Record<string, unknown>;
  if (!REPOSITORIES[modelId].includes(String(raw.repository))) return undefined;
  if (
    raw.revision !== null &&
    (typeof raw.revision !== "string" || !/^[a-f0-9]{40}$/i.test(raw.revision))
  )
    return undefined;
  return {
    modelId,
    backendId: backend.id,
    precision: source.precision as SpeechPrecision | null,
    checkpoint: {
      repository: raw.repository as string,
      revision: raw.revision as string | null,
    },
    platform: source.platform as SpeechExecution["platform"],
    device: backend.device,
  };
}
