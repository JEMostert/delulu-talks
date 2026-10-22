import type {
  AppSettings,
  MagicModelInfo,
  ModelInfo,
  ModelProvenance,
  SpeechTier,
} from "./types";
import { DEFAULT_KOKORO_VOICE } from "./voice";

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
  speechEngine: "medium",
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
  wordPacks: [],
  vocabularyHints: true,
  voiceEnabled: false,
  voiceEngine: "kokoro",
  voiceName: DEFAULT_KOKORO_VOICE,
  voiceClone: "",
  voiceSpeed: 1,
  voiceVolume: 0.9,
  voiceOutputDeviceId: "default",
  voiceInterruptOnDictation: true,
  voiceNormalizeText: true,
  voiceKeepLoaded: false,
  voiceAgentBridge: false,
  listenSensitivity: 0.5,
  listenSilenceMs: 900,
  listenBargeIn: true,
  listenBargeInMs: 300,
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
      "R2T2 speech recognition on NVIDIA GPUs through Transformers on Linux and Windows. About 4 GB of GPU memory.",
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

const NVIDIA_LICENSE = {
  licenseName: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
};
const SHERPA_CONVERSION =
  "INT8 ONNX export of the NVIDIA NeMo checkpoint, published by the sherpa-onnx project (k2-fsa). Delulu does not convert it further.";

export const CANARY_MODEL: Omit<ModelInfo, "id"> = {
  identity: "canary",
  backendIds: ["onnx-cpu"],
  runtime: "sherpa-onnx · CPU",
  downloadSize: "200 MB",
  hfId: "csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8",
  name: "Canary 180M Flash",
  description:
    "NVIDIA Canary 180M Flash on the CPU. The smallest option: English, German, French and Spanish, with punctuation. Speak, then stop to transcribe.",
  provenance: {
    ...NVIDIA_LICENSE,
    variants: [
      {
        label: "NVIDIA Canary 180M Flash · INT8",
        revision: "9077164e0d3dd1d5353743e89ceaa1d3a770838c",
        conversion: SHERPA_CONVERSION,
        attributionUrl: "https://huggingface.co/nvidia/canary-180m-flash",
      },
    ],
  },
};

export const PARAKEET_MODEL: Omit<ModelInfo, "id"> = {
  identity: "parakeet",
  backendIds: ["onnx-cpu"],
  runtime: "sherpa-onnx · CPU",
  downloadSize: "630 MB",
  hfId: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
  name: "Parakeet TDT 0.6B",
  description:
    "NVIDIA Parakeet TDT 0.6B on the CPU. English uses v2, the English model; Automatic uses v3, which detects 25 European languages. Speak, then stop to transcribe.",
  provenance: {
    ...NVIDIA_LICENSE,
    variants: [
      {
        label: "NVIDIA Parakeet TDT 0.6B v2 · English · INT8",
        revision: "1ab9323565ddb038682214b292f588070a538ce2",
        conversion: SHERPA_CONVERSION,
        attributionUrl: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2",
      },
      {
        label: "NVIDIA Parakeet TDT 0.6B v3 · 25 languages · INT8",
        revision: "2bda32ec70b097a55adaa07d9a7173915b43cc78",
        conversion: SHERPA_CONVERSION,
        attributionUrl: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3",
      },
    ],
  },
};

/** The three speech choices, smallest first. Small and Medium run on any CPU. */
export const SPEECH_TIERS = [
  {
    id: "small",
    name: "Small",
    model: "Canary 180M",
    download: "200 MB",
    summary: "Runs on almost any computer.",
    detail: "English, German, French and Spanish. Least accurate of the three.",
    hardware: "Any CPU",
  },
  {
    id: "medium",
    name: "Medium",
    model: "Parakeet 0.6B",
    download: "630 MB",
    summary: "Fast and accurate on the CPU.",
    detail:
      "English, or automatic detection across 25 European languages. Recommended for most computers.",
    hardware: "Any CPU",
    recommended: true,
  },
  {
    id: "large",
    name: "Large",
    model: "R2T2",
    download: "~4 GB",
    summary: "Most accurate.",
    detail:
      "30 languages, automatic detection and vocabulary hints. Needs an NVIDIA GPU with about 4 GB of memory, or Apple Silicon.",
    hardware: "NVIDIA GPU or Apple Silicon",
  },
] as const satisfies readonly {
  id: SpeechTier;
  name: string;
  model: string;
  download: string;
  summary: string;
  detail: string;
  hardware: string;
  recommended?: boolean;
}[];

export function speechTierById(id: SpeechTier) {
  return SPEECH_TIERS.find((tier) => tier.id === id) ?? SPEECH_TIERS[1];
}

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

/** Recognition-language setting that lets the speech engine detect the language. */
export const AUTO_LANGUAGE = "auto";

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

/** Values the recognition-language setting accepts: automatic detection or a language. */
export const SETTING_LANGUAGES = [
  [AUTO_LANGUAGE, "Automatic"],
  ...LANGUAGES,
] as const;

export function modelById(id: AppSettings["model"]) {
  return MODELS.find((model) => model.id === id) ?? MODELS[0];
}

export function magicModelById(id: AppSettings["magicModel"]) {
  return MAGIC_MODELS.find((model) => model.id === id) ?? MAGIC_MODELS[1];
}
