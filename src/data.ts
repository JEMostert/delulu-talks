import type { AppSettings, MagicModelInfo, ModelInfo } from "./types";

export const DEFAULT_SETTINGS: AppSettings = {
  shortcut: "CommandOrControl+Shift+Space",
  shortcutMode: "hold",
  model: "crisperMedium",
  language: "en",
  pythonCommand: "python3",
  inputDeviceId: "default",
  inputDeviceLabel: "System default",
  transcriptionMode: "dual",
  pasteVersion: "intended",
  autoPaste: true,
  copyToClipboard: true,
  pastePortalToken: "",
  keepHistory: true,
  showOverlay: true,
  preloadModel: true,
  magicEnabled: true,
  magicModel: "qwen35Medium",
  magicPreset: "polish",
  magicAllowInferences: false,
  preloadMagicModel: true,
  modelIdleMinutes: 15,
  backend: "auto",
  computeType: "auto",
  speculativeDecoding: true,
  wordTimestamps: true,
  launchAtLogin: false,
  modelLicenseAccepted: false,
  customWords: [],
};

export const MODELS: ModelInfo[] = [
  {
    id: "crisperMedium",
    shorthand: "medium",
    hfId: "nyralabs/CrisperWhisper2.0_medium",
    name: "CrisperWhisper 2 Medium",
    role: "Best everyday balance",
    description: "Near-large quality with a friendlier memory footprint. The default for fast, precise local dictation.",
    size: "Medium",
    memory: "Balanced",
    latency: "Fast",
    accent: "coral",
    badges: ["Recommended", "Dual transcript", "Word timing"],
    recommended: true,
  },
  {
    id: "crisperTurbo",
    shorthand: "turbo",
    hfId: "nyralabs/CrisperWhisper2.0_turbo",
    name: "CrisperWhisper 2 Turbo",
    role: "Fastest response",
    description: "A four-decoder-layer model for the lowest dictation latency, with a modest quality tradeoff.",
    size: "Turbo",
    memory: "Medium",
    latency: "Fastest",
    accent: "blue",
    badges: ["Low latency", "Long-form", "Multilingual"],
  },
  {
    id: "crisperLarge",
    shorthand: "large",
    hfId: "nyralabs/CrisperWhisper2.0_large",
    name: "CrisperWhisper 2 Large",
    role: "Best open quality",
    description: "Nyra's highest-quality standard checkpoint. Pair it with Turbo for output-preserving speculative decoding.",
    size: "Large",
    memory: "High",
    latency: "Highest quality",
    accent: "violet",
    badges: ["Best accuracy", "Speculative", "Precise timing"],
  },
  {
    id: "crisperSmall",
    shorthand: "small",
    hfId: "nyralabs/CrisperWhisper2.0_small",
    name: "CrisperWhisper 2 Small",
    role: "Lightest footprint",
    description: "The smallest official 2.0 checkpoint for CPU-first systems or machines with limited memory.",
    size: "Small",
    memory: "Lowest",
    latency: "Lightweight",
    accent: "yellow",
    badges: ["Low memory", "Portable", "Offline"],
  },
];

export const MAGIC_MODELS: MagicModelInfo[] = [
  {
    id: "qwen35Small",
    hfId: "Qwen/Qwen3.5-0.8B",
    name: "Qwen 3.5 · 0.8B",
    role: "Quick polish",
    description: "The lightest option for cleanup, concise notes, and fast everyday rewrites.",
    parameters: "0.8B",
    memory: "~2 GB",
    speed: "Fastest",
  },
  {
    id: "qwen35Medium",
    hfId: "Qwen/Qwen3.5-2B",
    name: "Qwen 3.5 · 2B",
    role: "Best balance",
    description: "Stronger instruction following and structure without the footprint of the largest option.",
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
    description: "Best for detailed prompts, coding context, and useful constraints the source only implied.",
    parameters: "4B",
    memory: "~8.5 GB",
    speed: "Deliberate",
  },
];

export const LANGUAGES = [
  ["en", "English"], ["de", "German"], ["nl", "Dutch"], ["fr", "French"],
  ["es", "Spanish"], ["pt", "Portuguese"], ["it", "Italian"], ["pl", "Polish"],
  ["cs", "Czech"], ["el", "Greek"], ["sv", "Swedish"], ["da", "Danish"],
  ["fi", "Finnish"], ["no", "Norwegian"], ["uk", "Ukrainian"], ["ru", "Russian"],
  ["tr", "Turkish"], ["ar", "Arabic"], ["he", "Hebrew"], ["hi", "Hindi"],
  ["zh", "Chinese"], ["ja", "Japanese"], ["ko", "Korean"], ["vi", "Vietnamese"],
] as const;

export function modelById(id: AppSettings["model"]) {
  return MODELS.find((model) => model.id === id) ?? MODELS[0];
}

export function magicModelById(id: AppSettings["magicModel"]) {
  return MAGIC_MODELS.find((model) => model.id === id) ?? MAGIC_MODELS[1];
}
