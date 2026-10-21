/**
 * Renderer playback for Delulu Voice. The main process sends synthesized PCM
 * chunks in order; they are scheduled back to back on one AudioContext so an
 * utterance plays without gaps while its next chunk is still synthesizing.
 */
import type { VoicePlaybackChunk, VoicePlaybackEvent } from "./voice";

export type VoicePlayer = {
  play(chunk: VoicePlaybackChunk): void;
  /** Stop one utterance, or everything when null. Stopped chunks report nothing more. */
  stop(utteranceId: string | null): void;
  dispose(): void;
};

type Scheduled = {
  utteranceId: string;
  chunk: number;
  source: AudioBufferSourceNode;
  gain: GainNode;
  endsAt: number;
  startTimer: ReturnType<typeof setTimeout> | null;
};

/** Chromium supports choosing the output device; the DOM types may lag. */
type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

/** A small lead keeps the first chunk from starting in the past. */
const LEAD_SECONDS = 0.03;

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** 16-bit little-endian PCM to floats in [-1, 1). */
function samples(pcm: Uint8Array): Float32Array {
  const count = Math.floor(pcm.byteLength / 2);
  const view = new DataView(pcm.buffer, pcm.byteOffset, count * 2);
  const output = new Float32Array(count);
  for (let index = 0; index < count; index += 1)
    output[index] = view.getInt16(index * 2, true) / 32768;
  return output;
}

export function createVoicePlayer(
  report: (event: VoicePlaybackEvent) => void,
  createContext: () => AudioContext = () => new AudioContext(),
): VoicePlayer {
  let context: SinkContext | null = null;
  let sinkId: string | null = null;
  // Context time at which the last scheduled chunk ends.
  let cursor = 0;
  const scheduled = new Set<Scheduled>();

  const release = (entry: Scheduled) => {
    scheduled.delete(entry);
    if (entry.startTimer) clearTimeout(entry.startTimer);
    entry.source.onended = null;
    try {
      entry.source.disconnect();
      entry.gain.disconnect();
    } catch {
      // Already disconnected.
    }
  };

  const useSink = (audio: SinkContext, deviceId: string) => {
    const wanted = deviceId === "default" ? "" : deviceId;
    if (wanted === sinkId || typeof audio.setSinkId !== "function") return;
    sinkId = wanted;
    // A missing device must not silence speech: fall back to the default output.
    void audio.setSinkId(wanted).catch(() => {
      if (!wanted) return;
      sinkId = "";
      void audio.setSinkId?.("").catch(() => undefined);
    });
  };

  const play = (chunk: VoicePlaybackChunk) => {
    const fail = (reason: unknown) =>
      report({
        utteranceId: chunk.utteranceId,
        chunk: chunk.chunk,
        event: "failed",
        message: `Could not play speech: ${message(reason)}`,
      });
    let audio: SinkContext;
    try {
      audio = context ??= createContext() as SinkContext;
    } catch (reason) {
      fail(reason);
      return;
    }
    if (audio.state === "suspended") void audio.resume().catch(() => undefined);
    useSink(audio, chunk.outputDeviceId);
    const data = samples(chunk.pcm);
    if (!data.length) {
      // Nothing to hear, but the utterance must still advance.
      report({
        utteranceId: chunk.utteranceId,
        chunk: chunk.chunk,
        event: "started",
      });
      report({
        utteranceId: chunk.utteranceId,
        chunk: chunk.chunk,
        event: "ended",
      });
      return;
    }
    let entry: Scheduled;
    try {
      const buffer = audio.createBuffer(1, data.length, chunk.sampleRate);
      buffer.getChannelData(0).set(data);
      const source = audio.createBufferSource();
      const gain = audio.createGain();
      gain.gain.value = Math.min(1, Math.max(0, chunk.volume));
      source.buffer = buffer;
      source.connect(gain);
      gain.connect(audio.destination);
      const startAt = Math.max(audio.currentTime + LEAD_SECONDS, cursor);
      entry = {
        utteranceId: chunk.utteranceId,
        chunk: chunk.chunk,
        source,
        gain,
        endsAt: startAt + buffer.duration,
        startTimer: null,
      };
      source.onended = () => {
        // A chunk always reports that it started before it reports its end.
        const pending = entry.startTimer !== null;
        release(entry);
        if (pending) started();
        report({
          utteranceId: entry.utteranceId,
          chunk: entry.chunk,
          event: "ended",
        });
      };
      const started = () => {
        entry.startTimer = null;
        report({
          utteranceId: entry.utteranceId,
          chunk: entry.chunk,
          event: "started",
        });
      };
      source.start(startAt);
      cursor = entry.endsAt;
      scheduled.add(entry);
      // A chunk that plays right away reports now; queued ones when they begin.
      const delayMs = (startAt - audio.currentTime) * 1000;
      if (delayMs > 50) entry.startTimer = setTimeout(started, delayMs);
      else started();
    } catch (reason) {
      fail(reason);
    }
  };

  const stop = (utteranceId: string | null) => {
    for (const entry of [...scheduled]) {
      if (utteranceId !== null && entry.utteranceId !== utteranceId) continue;
      release(entry);
      try {
        entry.source.stop();
      } catch {
        // Never started or already ended.
      }
    }
    // Later utterances keep their slots; otherwise the queue starts fresh.
    cursor = Math.max(0, ...[...scheduled].map((entry) => entry.endsAt));
  };

  return {
    play,
    stop,
    dispose() {
      stop(null);
      const audio = context;
      context = null;
      sinkId = null;
      void audio?.close().catch(() => undefined);
    },
  };
}
