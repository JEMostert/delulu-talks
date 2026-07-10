import type { AppSettings, ModelInfo } from "./types";

export const DEFAULT_SETTINGS: AppSettings = {
  shortcut: "Ctrl+Shift+Space",
  recordingMode: "hold",
  model: "parakeetTdt06bV3",
  language: "auto",
  pythonCommand: "python3",
  inputDevice: "default",
  recordingSounds: true,
  outputStyle: "smart",
  autoPaste: true,
  pasteMethod: "ctrlV",
  keepHistory: true,
  punctuation: true,
  customWords: [],
};

export const MODELS: ModelInfo[] = [
  {
    id: "parakeetTdt06bV3",
    name: "Parakeet TDT 0.6B v3",
    maker: "NVIDIA",
    role: "Best for fast dictation",
    description: "High-throughput GGUF transcription with automatic detection or explicit language conditioning.",
    size: "0.6B",
    languages: "25 languages",
    latency: "GPU-fast",
    accent: "violet",
    badges: ["Dutch", "Auto language", "FastConformer"],
  },
  {
    id: "mossTranscribeDiarize",
    name: "MOSS Transcribe Diarize",
    maker: "OpenMOSS",
    role: "Best for meetings",
    description: "One-pass transcription with speaker labels, timestamps, hotwords, and acoustic event awareness.",
    size: "0.9B",
    languages: "English + Chinese",
    latency: "Long-form",
    accent: "coral",
    badges: ["Diarization", "Timestamps", "Hotwords"],
  },
  {
    id: "cohereTranscribe",
    name: "Cohere Transcribe",
    maker: "Cohere Labs",
    role: "Best for accuracy",
    description: "A focused 2B Conformer model with strong long-form accuracy across 14 languages.",
    size: "2B",
    languages: "14 languages",
    latency: "Fast offline",
    accent: "blue",
    badges: ["High accuracy", "Long-form", "Multilingual"],
  },
  {
    id: "nemotron35Streaming",
    name: "Nemotron 3.5 Streaming",
    maker: "NVIDIA",
    role: "Best for speed",
    description: "Cache-aware FastConformer RNNT built for low-latency multilingual transcription.",
    size: "0.6B",
    languages: "35 languages",
    latency: "Streaming-ready",
    accent: "violet",
    badges: ["Low latency", "35 languages", "Lightweight"],
  },
];

export const PARAKEET_LANGUAGES = new Set([
  "auto", "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it",
  "lv", "lt", "mt", "pl", "pt", "ro", "ru", "sk", "sl", "es", "sv", "uk",
]);

export const LANGUAGES = [
  ["auto", "Automatic"], ["bg", "Bulgarian"], ["hr", "Croatian"], ["cs", "Czech"],
  ["da", "Danish"], ["nl", "Dutch"], ["en", "English"], ["et", "Estonian"],
  ["fi", "Finnish"], ["fr", "French"], ["de", "German"], ["el", "Greek"],
  ["hu", "Hungarian"], ["it", "Italian"], ["lv", "Latvian"], ["lt", "Lithuanian"],
  ["mt", "Maltese"], ["pl", "Polish"], ["pt", "Portuguese"], ["ro", "Romanian"],
  ["ru", "Russian"], ["sk", "Slovak"], ["sl", "Slovenian"], ["es", "Spanish"],
  ["sv", "Swedish"], ["uk", "Ukrainian"], ["zh", "Chinese"], ["ar", "Arabic"],
  ["ja", "Japanese"], ["ko", "Korean"], ["vi", "Vietnamese"],
] as const;

export function modelById(id: AppSettings["model"]) {
  return MODELS.find((model) => model.id === id) ?? MODELS[0];
}
