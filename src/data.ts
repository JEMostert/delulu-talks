import type {
  AppSettings,
  MagicModelInfo,
  ModelInfo,
  ModelProvenance,
} from "./types";

export const DEFAULT_SHORTCUT = "Super+Z";
export const LEGACY_DEFAULT_SHORTCUT = "CommandOrControl+Shift+Space";

const R2T2_LICENSE = {
  licenseName: "NetEase Youdao Model Use License Agreement",
  licenseUrl:
    "https://github.com/netease-youdao/Confucius4-R2T2/blob/master/MODEL_LICENSE",
};

function rewriteProvenance(repo: string): ModelProvenance {
  return {
    licenseName: "Apache 2.0",
    licenseUrl: `https://huggingface.co/${repo}/blob/main/LICENSE`,
    variants: [
      {
        label: "Optional rewriting",
        revision: null,
        conversion:
          "Original Qwen checkpoint loaded through Transformers; no Delulu format conversion.",
      },
    ],
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 1,
  workflowVersion: 1,
  onboardingComplete: false,
  theme: "system",
  shortcut: DEFAULT_SHORTCUT,
  shortcutMode: "hold",
  model: "r2t2",
  language: "en",
  dictationMode: "prose",
  dictationFormatting: "preserve",
  pythonCommand: "python3",
  inputDeviceId: "default",
  inputDeviceLabel: "System default",
  trailingSilenceStopEnabled: false,
  trailingSilenceSeconds: 5,
  trailingSilenceThresholdDb: -45,
  autoPaste: true,
  pasteShortcut: "standard",
  pasteLastDelaySeconds: 3,
  copyToClipboard: true,
  restoreClipboardAfterPaste: false,
  spokenFormattingCommands: false,
  pastePortalToken: "",
  keepHistory: true,
  historyRetention: { maxAgeDays: null, maxCount: null },
  showOverlay: true,
  captureSoundsMuted: true,
  speechEngine: "r2t2",
  liveTyping: true,
  speechDevice: "auto",
  historyLimit: 50,
  captureSoundVolume: 0.15,
  preloadModel: true,
  magicEnabled: false,
  magicModel: "qwen35Medium",
  magicPreset: "polish",
  magicAllowInferences: false,
  preloadMagicModel: false,
  modelIdleMinutes: 15,
  memoryPolicy: "independent",
  launchAtLogin: false,
  menuBarOnly: false,
  customWords: [],
  personalProfiles: { schemaVersion: 1, profiles: [] },
  activePersonalProfile: null,
};

export const MODELS: ModelInfo[] = [
  {
    id: "r2t2",
    identity: "r2t2",
    backendIds: ["transformers-cuda"],
    runtime: "CUDA · Transformers",
    downloadSize: "~4 GB",
    hfId: "netease-youdao/Confucius4-R2T2",
    name: "R2T2",
    description:
      "R2T2 speech recognition on NVIDIA GPUs through Transformers on Linux and Windows. About 4 GB of GPU memory; live typing cuts phrases at your pauses.",
    recommended: true,
    provenance: {
      ...R2T2_LICENSE,
      variants: [
        {
          label: "Linux and Windows CUDA",
          revision: "185ce639118ad1362d049ca0d8ed04b6ec5cd6c9",
          conversion:
            "Delulu converts original R2T2 keys in memory using the official Transformers mappings, with strict weight loading. Conversion cache: transformers-5.15.0-v1.",
          attributionUrl:
            "https://github.com/JEMostert/delulu-talks/blob/main/electron/python/r2t2_checkpoint.py",
        },
      ],
    },
  },
  {
    id: "r2t2Mlx",
    identity: "r2t2",
    backendIds: ["mlx-audio"],
    hfId: "mlx-community/Confucius4-R2T2-bf16",
    name: "R2T2",
    runtime: "MLX Audio · BF16 · Apple Silicon",
    downloadSize: "~4.1 GB",
    description:
      "The Confucius4-R2T2 fine-tune runs directly through MLX on Apple Silicon. Uses an unquantized BF16 conversion, with selectable language. Requires macOS 15+ and native Python 3.12. Mac hardware validation is pending.",
    recommended: true,
    provenance: {
      ...R2T2_LICENSE,
      variants: [
        {
          label: "Apple Silicon MLX",
          revision: "747f5fc5f84bc9976baa2f02714e2fed67ed8611",
          conversion:
            "Unquantized BF16 conversion of netease-youdao/Confucius4-R2T2. The publisher records mlx_audio.convert from the xocialize/mlx-audio fork at 1792021, MLX 0.32.2, on an Apple M5 Max. These are the conversion tools, not the app runtime versions.",
          attributionUrl:
            "https://huggingface.co/mlx-community/Confucius4-R2T2-bf16/blob/747f5fc5f84bc9976baa2f02714e2fed67ed8611/README.md",
        },
      ],
    },
  },
];

/** The light engine: chosen in Settings → Speech, not through `model`. */
export const NEMOTRON_MODEL: Omit<ModelInfo, "id"> = {
  identity: "nemotron",
  backendIds: ["transformers-cuda", "transformers-cpu"],
  runtime: "Transformers · GPU or CPU",
  downloadSize: "~2.6 GB",
  hfId: "nvidia/nemotron-3.5-asr-streaming-0.6b",
  name: "Nemotron 3.5 Streaming",
  description:
    "NVIDIA's 0.6B streaming recognizer types word by word with about half a second of delay. About 1.3 GB of GPU memory, or runs on the CPU; less accurate than R2T2 in Dutch.",
  provenance: {
    licenseName: "OpenMDW 1.1",
    licenseUrl: "https://openmdw.ai/license/1-1/",
    variants: [
      {
        label: "Linux and Windows",
        revision: "ea30d66debe3740a08b573244286791d423d6b3e",
        conversion:
          "Original safetensors checkpoint loaded through Transformers; no Delulu format conversion.",
      },
    ],
  },
};

export const MAGIC_MODELS: MagicModelInfo[] = [
  {
    id: "qwen35Small",
    hfId: "Qwen/Qwen3.5-0.8B",
    name: "Qwen 3.5 · 0.8B",
    role: "Quick polish",
    description:
      "The lightest option for cleanup, concise notes, and fast everyday rewrites.",
    parameters: "0.8B",
    memory: "~2 GB",
    speed: "Fastest",
    provenance: rewriteProvenance("Qwen/Qwen3.5-0.8B"),
  },
  {
    id: "qwen35Medium",
    hfId: "Qwen/Qwen3.5-2B",
    name: "Qwen 3.5 · 2B",
    role: "Best balance",
    description:
      "Stronger instruction following and structure without the footprint of the largest option.",
    parameters: "2B",
    memory: "~4.5 GB",
    speed: "Balanced",
    provenance: rewriteProvenance("Qwen/Qwen3.5-2B"),
    recommended: true,
  },
  {
    id: "qwen35Large",
    hfId: "Qwen/Qwen3.5-4B",
    name: "Qwen 3.5 · 4B",
    role: "Deepest rewrite",
    description:
      "Best for detailed prompts, coding context, and useful constraints the source only implied.",
    parameters: "4B",
    memory: "~8.5 GB",
    speed: "Deliberate",
    provenance: rewriteProvenance("Qwen/Qwen3.5-4B"),
  },
];

export const LANGUAGES = [
  ["en", "English"],
  ["de", "German"],
  ["nl", "Dutch"],
  ["fr", "French"],
  ["es", "Spanish"],
  ["pt", "Portuguese"],
  ["it", "Italian"],
  ["pl", "Polish"],
  ["cs", "Czech"],
  ["el", "Greek"],
  ["sv", "Swedish"],
  ["da", "Danish"],
  ["fi", "Finnish"],
  ["no", "Norwegian"],
  ["uk", "Ukrainian"],
  ["ru", "Russian"],
  ["tr", "Turkish"],
  ["ar", "Arabic"],
  ["he", "Hebrew"],
  ["hi", "Hindi"],
  ["zh", "Chinese"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["vi", "Vietnamese"],
] as const;

export function modelById(id: AppSettings["model"]) {
  return MODELS.find((model) => model.id === id) ?? MODELS[0];
}

export function magicModelById(id: AppSettings["magicModel"]) {
  return MAGIC_MODELS.find((model) => model.id === id) ?? MAGIC_MODELS[1];
}
