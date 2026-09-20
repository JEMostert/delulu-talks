import type { AppSettings, MagicModelInfo, ModelInfo } from "./types";

export const DEFAULT_SHORTCUT = "Super+Z";
export const LEGACY_DEFAULT_SHORTCUT = "CommandOrControl+Shift+Space";

export const DEFAULT_SETTINGS: AppSettings = {
  workflowVersion: 1,
  onboardingComplete: false,
  theme: "system",
  shortcut: DEFAULT_SHORTCUT,
  shortcutMode: "hold",
  model: "r2t2",
  language: "en",
  pythonCommand: "python3",
  inputDeviceId: "default",
  inputDeviceLabel: "System default",
  autoPaste: true,
  copyToClipboard: true,
  pastePortalToken: "",
  keepHistory: true,
  showOverlay: true,
  preloadModel: true,
  magicEnabled: false,
  magicModel: "qwen35Medium",
  magicPreset: "polish",
  magicAllowInferences: false,
  preloadMagicModel: false,
  modelIdleMinutes: 15,
  launchAtLogin: false,
  customWords: [],
};

export const MODELS: ModelInfo[] = [
  {
    id: "r2t2",
    hfId: "netease-youdao/Confucius4-R2T2",
    name: "R2T2",
    description:
      "Low-latency streaming ASR built on Qwen3-ASR, running through vLLM on your CUDA GPU.",
    recommended: true,
  },
];

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
