export type Page = "home" | "models" | "vocabulary" | "history" | "settings";
export type RecordingMode = "hold" | "toggle";
export type ModelId = "parakeetTdt06bV3" | "mossTranscribeDiarize" | "cohereTranscribe" | "nemotron35Streaming";
export type OutputStyle = "smart" | "plain" | "speakerAware";
export type PasteMethod = "ctrlV" | "ctrlShiftV";
export type DictationPhase = "idle" | "bootstrapping" | "listening" | "transcribing" | "error";

export type CustomWord = {
  id: string;
  term: string;
  soundsLike: string;
  replacement: string;
  enabled: boolean;
};

export type AppSettings = {
  shortcut: string;
  recordingMode: RecordingMode;
  model: ModelId;
  language: string;
  pythonCommand: string;
  inputDevice: string;
  recordingSounds: boolean;
  outputStyle: OutputStyle;
  autoPaste: boolean;
  pasteMethod: PasteMethod;
  keepHistory: boolean;
  punctuation: boolean;
  customWords: CustomWord[];
};

export type DictationStatus = {
  phase: DictationPhase;
  message?: string | null;
};

export type HuggingFaceAuthStatus = {
  configured: boolean;
};

export type AudioLevel = {
  level: number;
};

export type TranscriptSegment = {
  start: number;
  end: number;
  speaker: string;
  text: string;
};

export type TranscriptRecord = {
  id: string;
  createdAt: number;
  durationMs: number;
  text: string;
  rawText: string;
  model: ModelId;
  language: string;
  segments: TranscriptSegment[];
};

export type ModelInfo = {
  id: ModelId;
  name: string;
  maker: string;
  role: string;
  description: string;
  size: string;
  languages: string;
  latency: string;
  accent: "coral" | "blue" | "violet";
  badges: string[];
};
