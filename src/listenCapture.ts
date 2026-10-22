/**
 * Microphone capture for listening sessions. Unlike dictation it runs across
 * many conversational turns: a separate echo-cancelled stream feeds the
 * utterance segmenter, which reports onsets, barge-ins and finished
 * utterances. Delulu's playback level is the echo reference.
 */
import captureWorkletUrl from "./captureWorklet.js?url&no-inline";
import { resample } from "./captureResample";
import { wav } from "./captureEncoding";
import type { ListenCaptureConfig, ListenCaptureEvent } from "./listening";
import {
  FRAME_SAMPLES,
  SAMPLE_RATE,
  UtteranceSegmenter,
  type SegmenterConfig,
} from "./voiceActivity";
import type { VoicePlayer } from "./voicePlayer";

type Dependencies = {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createContext: () => AudioContext;
};

const defaults = (): Dependencies => ({
  getUserMedia: (constraints) =>
    navigator.mediaDevices.getUserMedia(constraints),
  createContext: () => {
    // Capturing at 16 kHz lets the browser resample without block edges.
    try {
      return new AudioContext({
        sampleRate: SAMPLE_RATE,
        latencyHint: "interactive",
      });
    } catch {
      return new AudioContext({ latencyHint: "interactive" });
    }
  },
});

function segmenterConfig(config: ListenCaptureConfig): SegmenterConfig {
  return {
    sensitivity: config.sensitivity,
    silenceMs: config.silenceMs,
    minSpeechMs: config.minSpeechMs,
    preRollMs: config.preRollMs,
    bargeInMs: config.bargeInMs,
    maxUtteranceMs: config.maxUtteranceMs,
  };
}

function failure(reason: unknown): string {
  const name = reason instanceof DOMException ? reason.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microphone access was denied. Allow it in your system settings, then start listening again.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "The selected microphone is not available. Choose another input in Settings.";
  if (name === "NotReadableError")
    return "The microphone is busy or unavailable. Close other apps using it and try again.";
  return `Could not start listening: ${reason instanceof Error ? reason.message : String(reason)}`;
}

export class ListenCapture {
  private config: ListenCaptureConfig;
  private readonly segmenter: UtteranceSegmenter;
  private readonly dependencies: Dependencies;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private nodes: AudioNode[] = [];
  private paused = false;
  private stopped = false;

  constructor(
    readonly sessionId: string,
    config: ListenCaptureConfig,
    private readonly report: (event: ListenCaptureEvent) => void,
    private readonly player: () => VoicePlayer | null,
    dependencies: Partial<Dependencies> = {},
  ) {
    this.config = config;
    this.segmenter = new UtteranceSegmenter(segmenterConfig(config));
    this.dependencies = { ...defaults(), ...dependencies };
  }

  async start(): Promise<void> {
    try {
      const deviceId = this.config.deviceId;
      const stream = await this.dependencies.getUserMedia({
        audio: {
          ...(deviceId && deviceId !== "default"
            ? { deviceId: { exact: deviceId } }
            : {}),
          channelCount: 1,
          // The browser's echo canceller removes most of Delulu's own voice;
          // the segmenter's playback reference handles what remains.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      });
      if (this.stopped) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const track = stream.getAudioTracks()[0];
      track?.addEventListener("ended", () =>
        this.fail("The microphone was disconnected. Start listening again."),
      );
      const context = this.dependencies.createContext();
      this.context = context;
      await context.audioWorklet.addModule(captureWorkletUrl);
      if (this.stopped) return;
      const source = context.createMediaStreamSource(stream);
      const rate = context.sampleRate;
      const worklet = new AudioWorkletNode(context, "delulu-capture", {
        // One 20 ms frame per message keeps barge-in prompt.
        processorOptions: {
          flushSamples: Math.round((rate * FRAME_SAMPLES) / SAMPLE_RATE),
        },
      });
      const sink = context.createGain();
      sink.gain.value = 0;
      source.connect(worklet);
      worklet.connect(sink);
      sink.connect(context.destination);
      this.nodes = [source, worklet, sink];
      worklet.port.onmessage = (
        event: MessageEvent<{ samples?: Float32Array }>,
      ) => {
        const samples = event.data?.samples;
        if (samples)
          this.ingest(rate === SAMPLE_RATE ? samples : resample(samples, rate));
      };
      if (context.state === "suspended") await context.resume();
      this.report({
        type: "state",
        sessionId: this.sessionId,
        state: "listening",
      });
    } catch (reason) {
      this.fail(failure(reason));
    }
  }

  configure(config: ListenCaptureConfig): void {
    this.config = config;
    this.segmenter.configure(segmenterConfig(config));
  }

  /** Dictation owns the microphone: drop any partial utterance and ignore audio. */
  pause(): void {
    this.paused = true;
    this.segmenter.reset();
  }

  resume(): void {
    this.paused = false;
  }

  /** Feed 16 kHz samples; public so tests can drive the capture without a microphone. */
  ingest(samples: Float32Array): void {
    if (this.stopped || this.paused) return;
    const player = this.player();
    const playing = player?.isPlaying() ?? false;
    const events = this.segmenter.pushSamples(samples, {
      playing,
      playbackDb: playing ? player!.outputLevelDb() : -120,
    });
    for (const event of events) {
      if (event.type === "speechStart")
        this.report({
          type: "speechStart",
          sessionId: this.sessionId,
          duringPlayback: event.duringPlayback,
        });
      else if (event.type === "bargeIn") {
        if (!this.config.bargeIn) continue;
        // Stop talking now; main learns which replies were cut off.
        const utteranceIds = player?.interrupt() ?? [];
        this.report({
          type: "bargeIn",
          sessionId: this.sessionId,
          utteranceIds,
        });
      } else if (event.type === "discarded")
        this.report({
          type: "discarded",
          sessionId: this.sessionId,
          reason: event.reason,
        });
      else
        this.report({
          type: "utterance",
          sessionId: this.sessionId,
          wav: wav(event.samples, SAMPLE_RATE),
          durationMs: Math.round((event.samples.length * 1000) / SAMPLE_RATE),
          speechMs: event.speechMs,
          overlappedPlayback: event.overlappedPlayback,
        });
    }
  }

  private fail(message: string): void {
    if (this.stopped) return;
    this.release();
    this.report({
      type: "state",
      sessionId: this.sessionId,
      state: "failed",
      message,
    });
  }

  private release(): void {
    this.stopped = true;
    for (const node of this.nodes) {
      try {
        node.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    this.nodes = [];
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }

  /** Stop capturing. A finished utterance in progress is dropped, not sent. */
  stop(): void {
    if (this.stopped) return;
    this.release();
    this.report({
      type: "state",
      sessionId: this.sessionId,
      state: "stopped",
    });
  }
}
