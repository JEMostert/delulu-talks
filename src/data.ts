import type { AppSettings, ModelInfo } from "./types";

export const DEFAULT_SETTINGS: AppSettings = {
  shortcut: "Ctrl+Shift+Space",
  recordingMode: "hold",
  model: "parakeetTdt06bV3",
  language: "auto",
  pythonCommand: "python3",
  inputDevice: "default",
  outputStyle: "smart",
  autoPaste: true,
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
    description: "High-throughput FastConformer transcription with automatic language detection, punctuation, and capitalization.",
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

export const LANGUAGES = [
  ["auto", "Automatic"], ["en", "English"], ["zh", "Chinese"], ["nl", "Dutch"],
  ["de", "German"], ["fr", "French"], ["es", "Spanish"], ["pt", "Portuguese"],
  ["it", "Italian"], ["ar", "Arabic"], ["ja", "Japanese"], ["ko", "Korean"],
  ["vi", "Vietnamese"], ["pl", "Polish"], ["el", "Greek"], ["cs", "Czech"],
] as const;

export function modelById(id: AppSettings["model"]) {
  return MODELS.find((model) => model.id === id) ?? MODELS[0];
}
