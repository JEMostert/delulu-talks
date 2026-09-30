/** Proposed worker-boundary contract. No active R2T2 backend enables this yet. */
export const AUDIO_STREAM_VERSION = 1;
export const AUDIO_STREAM_LIMITS = Object.freeze({
  chunkSamples: 16_000,
  bufferedChunks: 8,
  bufferedSamples: 32_000,
  sessionSamples: 16_000 * 60 * 10,
});

type StreamIdentity = { streamVersion: 1; sessionId: string };
export type AudioStreamStart = StreamIdentity & {
  kind: "start";
  sampleRate: 16_000;
  channels: 1;
  encoding: "pcm-f32le";
};
export type AudioStreamChunk = StreamIdentity & {
  kind: "chunk";
  sequence: number;
  offsetSamples: number;
  sampleCount: number;
  /** Standard padded base64 of little-endian float32 PCM, without data URL prefix. */
  pcm: string;
};
export type AudioStreamFinalize = StreamIdentity & {
  kind: "finalize";
  /** Number of chunks accepted, also the next expected chunk sequence. */
  chunkCount: number;
  totalSamples: number;
};
export type AudioStreamCancel = StreamIdentity & { kind: "cancel" };
export type AudioStreamInput =
  | AudioStreamStart | AudioStreamChunk | AudioStreamFinalize | AudioStreamCancel;
export type AudioStreamEvent = StreamIdentity & (
  | { kind: "credit"; nextSequence: number; consumedChunks: number; availableSamples: number; availableChunks: number }
  | { kind: "transcript"; revision: number; committedText: string; provisionalText: string }
  | { kind: "final"; text: string; totalSamples: number }
  | { kind: "cancelled" }
  | { kind: "error"; code: string; message: string }
);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Audio stream message must be an object");
  return value as Record<string, unknown>;
}
function integer(value: unknown, name: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max)
    throw new Error(`Invalid audio stream ${name}`);
  return value;
}

/** Validate before retaining a payload or forwarding it across the boundary. */
export function validateAudioStreamInput(value: unknown): AudioStreamInput {
  const message = record(value);
  if (message.streamVersion !== AUDIO_STREAM_VERSION)
    throw new Error("Audio stream version mismatch");
  if (typeof message.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(message.sessionId))
    throw new Error("Invalid audio stream session ID");
  const identity: StreamIdentity = { streamVersion: 1, sessionId: message.sessionId };
  switch (message.kind) {
    case "start":
      if (message.sampleRate !== 16_000 || message.channels !== 1 || message.encoding !== "pcm-f32le")
        throw new Error("Audio stream requires 16 kHz mono float32 little-endian PCM");
      return { ...identity, kind: "start", sampleRate: 16_000, channels: 1, encoding: "pcm-f32le" };
    case "chunk": {
      const sequence = integer(message.sequence, "sequence", AUDIO_STREAM_LIMITS.sessionSamples);
      const offsetSamples = integer(message.offsetSamples, "sample offset", AUDIO_STREAM_LIMITS.sessionSamples);
      const sampleCount = integer(message.sampleCount, "sample count", AUDIO_STREAM_LIMITS.chunkSamples);
      if (!sampleCount) throw new Error("Audio stream chunks must contain samples");
      const bytes = sampleCount * 4;
      const encodedLength = 4 * Math.ceil(bytes / 3);
      if (typeof message.pcm !== "string" || message.pcm.length !== encodedLength ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.pcm))
        throw new Error("Invalid or oversized audio stream PCM base64");
      const padding = message.pcm.endsWith("==") ? 2 : message.pcm.endsWith("=") ? 1 : 0;
      if (encodedLength / 4 * 3 - padding !== bytes)
        throw new Error("Audio stream PCM length does not match sample count");
      return { ...identity, kind: "chunk", sequence, offsetSamples, sampleCount, pcm: message.pcm };
    }
    case "finalize":
      return {
        ...identity, kind: "finalize",
        chunkCount: integer(message.chunkCount, "chunk count", AUDIO_STREAM_LIMITS.sessionSamples),
        totalSamples: integer(message.totalSamples, "total samples", AUDIO_STREAM_LIMITS.sessionSamples),
      };
    case "cancel": return { ...identity, kind: "cancel" };
    default: throw new Error("Unknown audio stream message kind");
  }
}

/** One session per instance; owns only bounded unconsumed PCM, never raw transcripts. */
export class AudioStreamSession {
  readonly sessionId: string;
  private phase: "open" | "draining" | "final" | "cancelled" = "open";
  private chunks: AudioStreamChunk[] = [];
  private acceptedChunks = 0;
  private consumedChunks = 0;
  private totalSamples = 0;
  private bufferedSamples = 0;

  constructor(start: AudioStreamStart) {
    const message = validateAudioStreamInput(start);
    if (message.kind !== "start") throw new Error("Audio stream must begin with start");
    this.sessionId = message.sessionId;
  }

  accept(value: unknown): void {
    const message = validateAudioStreamInput(value);
    if (message.sessionId !== this.sessionId) throw new Error("Stale or foreign audio stream session");
    if (message.kind === "cancel") {
      if (this.phase === "final") throw new Error("Final audio stream cannot be cancelled");
      this.phase = "cancelled";
      this.chunks = [];
      this.bufferedSamples = 0;
      return; // Cancellation is idempotent, including while draining.
    }
    if (this.phase !== "open") throw new Error("Audio stream no longer accepts input");
    if (message.kind === "chunk") {
      if (message.sequence !== this.acceptedChunks || message.offsetSamples !== this.totalSamples)
        throw new Error("Audio stream chunk is duplicated, missing or out of order");
      if (this.totalSamples + message.sampleCount > AUDIO_STREAM_LIMITS.sessionSamples)
        throw new Error("Audio stream session duration limit reached");
      if (this.chunks.length >= AUDIO_STREAM_LIMITS.bufferedChunks ||
          this.bufferedSamples + message.sampleCount > AUDIO_STREAM_LIMITS.bufferedSamples)
        throw new Error("Audio stream has no buffer credit; pause and retry the same chunk");
      this.chunks.push(message);
      this.acceptedChunks++;
      this.totalSamples += message.sampleCount;
      this.bufferedSamples += message.sampleCount;
    } else if (message.kind === "finalize") {
      if (message.chunkCount !== this.acceptedChunks || message.totalSamples !== this.totalSamples)
        throw new Error("Audio stream finalization does not match accepted audio");
      this.phase = "draining";
    } else throw new Error("Audio stream session has already started");
  }

  /** Retain the head until inference consumes it, including while it is in flight. */
  peekChunk(): AudioStreamChunk | null {
    return this.chunks.length ? { ...this.chunks[0] } : null;
  }

  consumeChunk(sequence: number): void {
    if (this.phase === "cancelled" || this.phase === "final")
      throw new Error("Audio stream session is terminal");
    const chunk = this.chunks[0];
    if (!chunk || chunk.sequence !== sequence) throw new Error("Audio stream consumption is out of order");
    this.chunks.shift();
    this.consumedChunks++;
    this.bufferedSamples -= chunk.sampleCount;
  }

  credit(): AudioStreamEvent {
    if (this.phase !== "open") throw new Error("Audio stream is not accepting chunks");
    return {
      streamVersion: 1, sessionId: this.sessionId, kind: "credit",
      nextSequence: this.acceptedChunks, consumedChunks: this.consumedChunks,
      availableSamples: AUDIO_STREAM_LIMITS.bufferedSamples - this.bufferedSamples,
      availableChunks: AUDIO_STREAM_LIMITS.bufferedChunks - this.chunks.length,
    };
  }

  finish(text: string): AudioStreamEvent {
    if (this.phase !== "draining" || this.chunks.length)
      throw new Error("Audio stream must finalize and consume all chunks before producing final text");
    if (typeof text !== "string" || text.length > 500_000)
      throw new Error("Invalid or oversized audio stream final text");
    this.phase = "final";
    return { streamVersion: 1, sessionId: this.sessionId, kind: "final", text, totalSamples: this.totalSamples };
  }
}
