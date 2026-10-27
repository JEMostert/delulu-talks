/**
 * Shared contracts for spoken output: Siren. No Electron or platform
 * dependencies, so the renderer, the main process and tests share them.
 *
 * The markup follows Grok's text-to-speech design: one-off inline tags in
 * square brackets fire a single sound, and wrapping tags change how a span is
 * spoken. See docs/SIREN.md for the specification.
 */
import type {
  DownloadBytes,
  EnginePhase,
  RuntimeLifecycle,
  SetupStage,
  SetupState,
} from "./types";
import type { DomainFailure } from "./domainErrors";

/** Small runs Kokoro on any CPU; Large runs Chatterbox Turbo on a GPU, with tags. */
export type VoiceEngineId = "kokoro" | "chatterbox-turbo";
export const VOICE_ENGINES: readonly VoiceEngineId[] = [
  "kokoro",
  "chatterbox-turbo",
];
export const isVoiceEngineId = (value: unknown): value is VoiceEngineId =>
  value === "kokoro" || value === "chatterbox-turbo";

export type VoiceEngineInfo = {
  id: VoiceEngineId;
  tier: "small" | "large";
  name: string;
  runtime: string;
  description: string;
  downloadSize: string;
  license: string;
  repository: string;
  revision: string;
  /** Whether non-verbal sounds and speaking styles are performed natively. */
  expressive: boolean;
};

export const VOICE_ENGINE_INFO: Record<VoiceEngineId, VoiceEngineInfo> = {
  kokoro: {
    id: "kokoro",
    tier: "small",
    name: "Kokoro",
    runtime: "CPU · sherpa-onnx",
    description: "Quick and clear on any computer",
    downloadSize: "330 MB",
    license: "Apache-2.0",
    repository: "csukuangfj/kokoro-multi-lang-v1_0",
    revision: "f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b",
    expressive: false,
  },
  "chatterbox-turbo": {
    id: "chatterbox-turbo",
    tier: "large",
    name: "Chatterbox",
    runtime: "GPU · PyTorch",
    description: "Laughs, sighs, whispers and clones a voice",
    downloadSize: "4 GB",
    license: "MIT",
    repository: "ResembleAI/chatterbox-turbo",
    revision: "749d1c1a46eb10492095d68fbcf55691ccf137cd",
    expressive: true,
  },
};

export type VoiceOption = {
  id: string;
  label: string;
  accent: "American" | "British";
  gender: "female" | "male";
};

/** Kokoro v1.0 English speakers; ids are the speaker names in the model metadata. */
export const KOKORO_VOICES: readonly VoiceOption[] = (
  [
    ["af_heart", "Heart"],
    ["af_bella", "Bella"],
    ["af_nicole", "Nicole"],
    ["af_sarah", "Sarah"],
    ["af_sky", "Sky"],
    ["af_nova", "Nova"],
    ["af_river", "River"],
    ["af_jessica", "Jessica"],
    ["af_kore", "Kore"],
    ["af_aoede", "Aoede"],
    ["af_alloy", "Alloy"],
    ["am_michael", "Michael"],
    ["am_fenrir", "Fenrir"],
    ["am_puck", "Puck"],
    ["am_eric", "Eric"],
    ["am_liam", "Liam"],
    ["am_onyx", "Onyx"],
    ["am_adam", "Adam"],
    ["am_echo", "Echo"],
    ["bf_emma", "Emma"],
    ["bf_isabella", "Isabella"],
    ["bf_alice", "Alice"],
    ["bf_lily", "Lily"],
    ["bm_george", "George"],
    ["bm_fable", "Fable"],
    ["bm_lewis", "Lewis"],
    ["bm_daniel", "Daniel"],
  ] as const
).map(([id, label]) => ({
  id,
  label,
  accent: id[0] === "a" ? "American" : "British",
  gender: id[1] === "f" ? "female" : "male",
}));
export const DEFAULT_KOKORO_VOICE = "af_heart";
export const isKokoroVoice = (value: unknown): value is string =>
  KOKORO_VOICES.some((voice) => voice.id === value);

/* ------------------------------------------------------------------ */
/* Markup vocabulary                                                   */
/* ------------------------------------------------------------------ */

/** One-off sounds: `[laugh]`. Pauses are silence of a fixed length. */
export type VoiceEventTag =
  | "laugh"
  | "chuckle"
  | "sigh"
  | "gasp"
  | "cough"
  | "clear-throat"
  | "sniff"
  | "groan"
  | "shush";
export const VOICE_EVENT_TAGS: readonly VoiceEventTag[] = [
  "laugh",
  "chuckle",
  "sigh",
  "gasp",
  "cough",
  "clear-throat",
  "sniff",
  "groan",
  "shush",
];
/** Silence inserted by `[pause]` and `[long-pause]`. */
export const VOICE_PAUSES = { pause: 400, "long-pause": 1200 } as const;
export type VoicePauseTag = keyof typeof VOICE_PAUSES;

/** Wrapping styles: `<whisper>…</whisper>`. Emotions are Chatterbox-only. */
export type VoiceEmotionStyle =
  | "whisper"
  | "happy"
  | "angry"
  | "surprised"
  | "scared"
  | "sarcastic"
  | "dramatic"
  | "narration"
  | "crying";
export type VoiceProsodyStyle = "slow" | "fast" | "soft" | "loud" | "emphasis";
export type VoiceStyle = VoiceEmotionStyle | VoiceProsodyStyle;
export const VOICE_EMOTION_STYLES: readonly VoiceEmotionStyle[] = [
  "whisper",
  "happy",
  "angry",
  "surprised",
  "scared",
  "sarcastic",
  "dramatic",
  "narration",
  "crying",
];
export const VOICE_PROSODY_STYLES: readonly VoiceProsodyStyle[] = [
  "slow",
  "fast",
  "soft",
  "loud",
  "emphasis",
];
export const VOICE_STYLES: readonly VoiceStyle[] = [
  ...VOICE_EMOTION_STYLES,
  ...VOICE_PROSODY_STYLES,
];

/* ------------------------------------------------------------------ */
/* Worker wire format (voice runtime role)                             */
/* ------------------------------------------------------------------ */

/** A synthesis request is a short run of parts that share one style set. */
export type VoicePart =
  | { kind: "text"; text: string }
  | { kind: "event"; tag: VoiceEventTag }
  | { kind: "pause"; ms: number };

export const VOICE_LIMITS = {
  /** Characters accepted from one speak request (Grok accepts 15,000). */
  requestCharacters: 15_000,
  /** Text characters in one synthesis chunk sent to the worker. */
  chunkCharacters: 600,
  /** Parts in one synthesis chunk. */
  chunkParts: 200,
  /** Longest single pause. */
  pauseMs: 5_000,
  /** Styles active at once. */
  styles: 8,
  /** Audio the worker may return for one chunk. */
  chunkAudioSeconds: 90,
  /** Utterances waiting behind the one being spoken. */
  queue: 20,
} as const;

export type VoiceSynthesizeRequest = {
  engine: VoiceEngineId;
  /** Kokoro speaker id; ignored by Chatterbox. */
  voice: string;
  /** Absolute path of a reference clip for Chatterbox voice cloning. */
  reference?: string;
  speed: number;
  styles: VoiceStyle[];
  parts: VoicePart[];
};

export type VoiceSynthesizeResult = {
  sampleRate: number;
  /** Base64 little-endian 16-bit mono PCM. */
  audio: string;
  durationMs: number;
  processingTimeMs: number;
  engine: VoiceEngineId;
  device: string;
  /** Tags and styles this engine could not perform; they were skipped. */
  unsupported: string[];
};

/* ------------------------------------------------------------------ */
/* Desktop service                                                     */
/* ------------------------------------------------------------------ */

export type VoiceSource = "app" | "agent" | "clipboard";

export type VoiceSpeakRequest = {
  text: string;
  source?: VoiceSource;
  /** Display label of the speaking agent, such as "Claude Code". */
  agent?: string;
  /** Stop current speech and clear the queue first. */
  interrupt?: boolean;
  /** Turn code, paths and identifiers into speakable words (default on). */
  normalize?: boolean;
  /** Caller's id for this spoken response; interruptions report it. Generated when omitted. */
  responseId?: string;
};

/** Exact chunk boundaries, measured from the synthesized audio. */
export type VoiceTimestamp = { text: string; startMs: number; endMs: number };

export type VoiceUtteranceOutcome =
  "queued" | "speaking" | "spoken" | "stopped" | "interrupted" | "failed";

export type VoiceSpeakResult = {
  id: string;
  responseId: string;
  outcome: VoiceUtteranceOutcome;
  durationMs: number;
  timestamps: VoiceTimestamp[];
  /** Markup problems: unknown or unclosed tags. */
  warnings: string[];
  /** Tags the selected engine skipped. */
  unsupported: string[];
  error?: string;
};

/** `position` is how many utterances are ahead; 0 starts right away. */
export type VoiceQueued = { id: string; responseId: string; position: number };

export type VoiceUtteranceSummary = {
  id: string;
  at: number;
  source: VoiceSource;
  agent: string | null;
  /** Spoken text without markup, truncated for display. */
  text: string;
  outcome: VoiceUtteranceOutcome;
  durationMs: number;
};

export type VoiceBridgeStatus = {
  enabled: boolean;
  listening: boolean;
  /** Agent connections open right now. */
  clients: number;
  endpoint: string | null;
  error: string | null;
};

export type VoicePhase = "idle" | "synthesizing" | "speaking";

export type VoiceStatus = RuntimeLifecycle & {
  engine: EnginePhase;
  phase: VoicePhase;
  message: string;
  detail?: string | null;
  progress?: number | null;
  setupStage?: SetupStage | null;
  setupState?: SetupState;
  downloadBytes?: DownloadBytes | null;
  failure?: DomainFailure | null;
  migrationRequired?: boolean;
  model: VoiceEngineId | null;
  current: {
    id: string;
    text: string;
    source: VoiceSource;
    agent: string | null;
    chunk: number;
    chunks: number;
  } | null;
  queued: number;
  recent: VoiceUtteranceSummary[];
  bridge: VoiceBridgeStatus;
};

/** One chunk of synthesized speech for the renderer to play. */
export type VoicePlaybackChunk = {
  utteranceId: string;
  chunk: number;
  last: boolean;
  sampleRate: number;
  /** 16-bit little-endian mono PCM. */
  pcm: Uint8Array;
  volume: number;
  outputDeviceId: string;
};

export type VoicePlaybackEvent = {
  utteranceId: string;
  chunk: number;
  event: "started" | "ended" | "failed";
  message?: string;
};

/** Copyable setup for coding agents; paths are resolved on this machine. */
export type VoiceAgentSetup = {
  /** The Delulu Talks executable, which serves MCP and the CLI via `mcp`. */
  scriptPath: string;
  /** How to run the server: the app executable followed by `mcp`. */
  command: string[];
  /** Kept for the wire shape; always false since no Node runtime is used. */
  nodeFound: boolean;
  claudeCode: string;
  codex: string;
  json: string;
  shell: string;
  instructions: string;
};

/** What the CEO agent is told about speaking; also served as MCP instructions. */
export const VOICE_AGENT_INSTRUCTIONS = `You can talk to the user out loud with the delulu-voice speak tool. You are the lead agent: other agents and threads report to you, and only you speak to the user. Treat the user as your board and give them short spoken briefings.

When to speak:
- When work is done, when you are blocked, when you need a decision, or when something important broke or changed.
- Not for routine progress, and never once per subtask.

How to speak:
- One to three short sentences, like a colleague talking, not a report.
- Never read code, diffs, file contents, logs or long lists aloud. Name the file or the outcome instead.
- Ask one clear question when you need a decision.

Expressive markup (Grok-style):
- One-off sounds: [laugh] [chuckle] [sigh] [gasp] [cough] [clear-throat] [sniff] [groan] [shush]
- Pauses: [pause] [long-pause]
- Wrapping styles: <whisper>…</whisper> <happy>…</happy> <angry>…</angry> <surprised>…</surprised> <scared>…</scared> <sarcastic>…</sarcastic> <dramatic>…</dramatic> <narration>…</narration> <crying>…</crying>
- Pacing and volume: <slow>…</slow> <fast>…</fast> <soft>…</soft> <loud>…</loud> <emphasis>…</emphasis>
Use tags sparingly, where a person would really do it: "[sigh] the build still fails on the cache path. Want me to try another way?"`;
