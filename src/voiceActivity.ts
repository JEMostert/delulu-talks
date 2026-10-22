/**
 * Voice activity detection and utterance segmentation for listening sessions.
 * Dependency-free and deterministic: it consumes 20 ms frames of 16 kHz mono
 * audio and reports when an utterance starts, when the user talks over
 * Delulu's own speech, and when an utterance is complete.
 *
 * A frame counts as speech when its speech-band (150–4000 Hz) energy clears an
 * adaptive noise floor by a sensitivity-dependent margin and most of its
 * energy lies in that band. While Delulu is playing, it must also clear an
 * estimate of the echo: the playback level plus a learned speaker-to-mic
 * coupling plus a safety margin.
 */

export const SAMPLE_RATE = 16_000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;

export type SegmenterConfig = {
  /** 0 hears only clear, loud speech; 1 also quiet speech. */
  sensitivity: number;
  silenceMs: number;
  minSpeechMs: number;
  preRollMs: number;
  bargeInMs: number;
  maxUtteranceMs: number;
};

export type FrameContext = {
  /** Delulu is playing speech right now. */
  playing: boolean;
  /** Playback output level in dBFS (−120 when silent). */
  playbackDb: number;
};

export type SegmenterEvent =
  | { type: "speechStart"; duringPlayback: boolean }
  | { type: "bargeIn" }
  | {
      type: "utterance";
      samples: Float32Array;
      speechMs: number;
      overlappedPlayback: boolean;
      /** Absolute sample index of the first sample, for diagnostics and tests. */
      startSample: number;
    }
  | { type: "discarded"; reason: string };

/** Voiced audio an utterance needs; shorter sounds are dropped. */
const MIN_VOICED_MS = 250;
/** Non-speech frames tolerated inside an onset run. */
const ONSET_GAP_FRAMES = 3;
/** Treat the room as echoing for this long after playback stops. */
const PLAYBACK_TAIL_FRAMES = 15;
/** Playback level is compared with the loudest of recent frames (echo delay). */
const PLAYBACK_HISTORY_FRAMES = 8;
const ECHO_MARGIN_DB = 6;
/** Until learned, assume echo arrives 6 dB below the output. */
const INITIAL_COUPLING_DB = -6;
/** Opening frames of each reply used to calibrate the echo estimate (1.5 s). */
const COUPLING_WINDOW_FRAMES = 75;
/** Calibration frames needed before the estimate replaces the cautious default. */
const COUPLING_MIN_FRAMES = 25;
/** Silence kept after the last word of an utterance. */
const TRAILING_MS = 200;
/** Fraction of frame energy that must be in the speech band. */
const MIN_BAND_RATIO = 0.15;

type Biquad = {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
};

/** RBJ cookbook high- or low-pass section. */
function biquad(kind: "high" | "low", frequency: number): Biquad {
  const w = (2 * Math.PI * frequency) / SAMPLE_RATE;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  const b1 = kind === "low" ? 1 - cos : -(1 + cos);
  const b0 = kind === "low" ? (1 - cos) / 2 : (1 + cos) / 2;
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b0 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0,
  };
}

function filter(section: Biquad, x: number): number {
  const y =
    section.b0 * x +
    section.b1 * section.x1 +
    section.b2 * section.x2 -
    section.a1 * section.y1 -
    section.a2 * section.y2;
  section.x2 = section.x1;
  section.x1 = x;
  section.y2 = section.y1;
  section.y1 = y;
  return y;
}

const db = (energy: number) => 10 * Math.log10(energy + 1e-12);

export class UtteranceSegmenter {
  private config: SegmenterConfig;
  private readonly high = biquad("high", 150);
  private readonly low = biquad("low", 4000);
  private floorDb: number | null = null;
  private couplingDb = INITIAL_COUPLING_DB;
  private echoObservations: number[] = [];
  private playbackFrames = 0;
  private readonly playbackHistory: number[] = [];
  private framesSincePlaying = Infinity;
  private frameIndex = 0;
  /** Recent frames for pre-roll; oldest first. */
  private ring: Float32Array[] = [];
  private ringCapacity = 0;
  /** Onset candidate. */
  private runStart = -1;
  private runSpeech = 0;
  private runGap = 0;
  private runDuringPlayback = false;
  /** Active utterance. */
  private active: {
    frames: Float32Array[];
    startFrame: number;
    speechFrames: number;
    silenceFrames: number;
    lastSpeechLength: number;
    overlapped: boolean;
  } | null = null;
  private pending = new Float32Array(FRAME_SAMPLES);
  private pendingLength = 0;

  constructor(config: SegmenterConfig) {
    this.config = config;
    this.resize();
  }

  configure(config: SegmenterConfig): void {
    this.config = config;
    this.resize();
  }

  private resize(): void {
    this.ringCapacity =
      Math.ceil(
        (this.config.preRollMs +
          Math.max(this.config.minSpeechMs, this.config.bargeInMs)) /
          FRAME_MS,
      ) + 10;
    while (this.ring.length > this.ringCapacity) this.ring.shift();
  }

  get speaking(): boolean {
    return this.active !== null;
  }

  /** Drop any partial utterance, e.g. while dictation owns the microphone. */
  reset(): void {
    this.active = null;
    this.runStart = -1;
    this.runSpeech = 0;
    this.runGap = 0;
    this.ring = [];
  }

  /** Feed any number of samples; they are split into 20 ms frames. */
  pushSamples(samples: Float32Array, context: FrameContext): SegmenterEvent[] {
    const events: SegmenterEvent[] = [];
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(
        FRAME_SAMPLES - this.pendingLength,
        samples.length - offset,
      );
      this.pending.set(
        samples.subarray(offset, offset + take),
        this.pendingLength,
      );
      this.pendingLength += take;
      offset += take;
      if (this.pendingLength === FRAME_SAMPLES) {
        this.pendingLength = 0;
        events.push(...this.push(this.pending.slice(), context));
      }
    }
    return events;
  }

  /** Feed exactly one 20 ms frame. */
  push(frame: Float32Array, context: FrameContext): SegmenterEvent[] {
    const events: SegmenterEvent[] = [];
    const index = this.frameIndex++;

    let total = 0;
    let band = 0;
    for (let i = 0; i < frame.length; i++) {
      const x = frame[i];
      total += x * x;
      const y = filter(this.low, filter(this.high, x));
      band += y * y;
    }
    total /= frame.length;
    band /= frame.length;
    const bandDb = db(band);
    const ratio = band / (total + 1e-12);

    // Playback awareness, including the echo tail after it stops.
    if (context.playing) {
      // A new reply after a quiet spell recalibrates the echo estimate.
      if (this.framesSincePlaying > PLAYBACK_TAIL_FRAMES) {
        this.playbackFrames = 0;
        this.echoObservations = [];
      }
      this.framesSincePlaying = 0;
      this.playbackFrames += 1;
    } else this.framesSincePlaying += 1;
    const echoing = this.framesSincePlaying <= PLAYBACK_TAIL_FRAMES;
    this.playbackHistory.push(context.playing ? context.playbackDb : -120);
    if (this.playbackHistory.length > PLAYBACK_HISTORY_FRAMES)
      this.playbackHistory.shift();
    const playbackDb = Math.max(...this.playbackHistory);

    const sensitivity = Math.min(1, Math.max(0, this.config.sensitivity));
    const thresholdDb = 18 - 12 * sensitivity;
    const absoluteDb = -50 - 15 * sensitivity;
    if (this.floorDb === null) this.floorDb = Math.max(-90, bandDb);
    // Hysteresis: once speaking, quieter word endings still count.
    const relax = this.active ? 3 : 0;
    let speech =
      bandDb > this.floorDb + thresholdDb - relax &&
      bandDb > absoluteDb - relax &&
      ratio > MIN_BAND_RATIO;

    let echoGated = false;
    if (echoing && playbackDb > -90) {
      const echoDb = playbackDb + this.couplingDb;
      const clears = bandDb > echoDb + ECHO_MARGIN_DB;
      if (
        !clears &&
        !this.active &&
        this.runStart < 0 &&
        this.playbackFrames <= COUPLING_WINDOW_FRAMES
      ) {
        // Calibrate on the first moments of each reply, when the user is
        // almost always listening: the loudest echo relative to playback.
        // Later frames never raise it, so the user's voice cannot teach the
        // detector to ignore the user.
        this.echoObservations.push(bandDb - playbackDb);
        if (this.echoObservations.length > COUPLING_WINDOW_FRAMES)
          this.echoObservations.shift();
        if (this.echoObservations.length >= COUPLING_MIN_FRAMES) {
          // A high percentile, not the maximum: a single loud echo frame
          // would otherwise make the user inaudible over the whole reply.
          const sorted = [...this.echoObservations].sort((a, b) => a - b);
          this.couplingDb = sorted[Math.floor(sorted.length * 0.8)];
        }
      }
      echoGated = !clears;
      speech = speech && clears;
    }

    // The noise floor rises slowly (1 dB/s) and falls quickly; never from
    // speech or from frames dominated by Delulu's own playback.
    if (!speech && !this.active && !(echoing && echoGated)) {
      if (bandDb < this.floorDb)
        this.floorDb = Math.max(
          -90,
          this.floorDb + (bandDb - this.floorDb) / 2,
        );
      else this.floorDb = Math.min(bandDb, this.floorDb + 0.02);
    }

    this.ring.push(frame);
    if (this.ring.length > this.ringCapacity) this.ring.shift();

    if (this.active) {
      const active = this.active;
      active.frames.push(frame);
      if (echoing) active.overlapped = true;
      if (speech) {
        active.speechFrames += 1;
        active.silenceFrames = 0;
        active.lastSpeechLength = active.frames.length;
      } else active.silenceFrames += 1;
      const durationMs = active.frames.length * FRAME_MS;
      if (
        active.silenceFrames * FRAME_MS >= this.config.silenceMs ||
        durationMs >= this.config.maxUtteranceMs
      )
        events.push(this.finish());
      return events;
    }

    // Looking for an onset.
    if (speech) {
      if (this.runStart < 0) {
        this.runStart = index;
        this.runSpeech = 0;
        this.runDuringPlayback = echoing;
      }
      if (echoing) this.runDuringPlayback = true;
      this.runSpeech += 1;
      this.runGap = 0;
    } else if (this.runStart >= 0) {
      this.runGap += 1;
      if (this.runGap > ONSET_GAP_FRAMES) {
        this.runStart = -1;
        this.runSpeech = 0;
        this.runGap = 0;
      }
    }
    const needed = this.runDuringPlayback
      ? this.config.bargeInMs
      : this.config.minSpeechMs;
    if (this.runStart >= 0 && this.runSpeech * FRAME_MS >= needed) {
      const preRollFrames = Math.ceil(this.config.preRollMs / FRAME_MS);
      const first = Math.max(
        this.runStart - preRollFrames,
        index - this.ring.length + 1,
      );
      const frames = this.ring.slice(this.ring.length - (index - first + 1));
      this.active = {
        frames,
        startFrame: first,
        speechFrames: this.runSpeech,
        silenceFrames: 0,
        lastSpeechLength: frames.length,
        overlapped: echoing || this.runDuringPlayback,
      };
      const duringPlayback = this.runDuringPlayback;
      this.runStart = -1;
      this.runSpeech = 0;
      this.runGap = 0;
      events.push({ type: "speechStart", duringPlayback });
      if (duringPlayback) events.push({ type: "bargeIn" });
    }
    return events;
  }

  /** Finalize the active utterance now (session stop, forced end). */
  flush(): SegmenterEvent[] {
    return this.active ? [this.finish()] : [];
  }

  private finish(): SegmenterEvent {
    const active = this.active!;
    this.active = null;
    const speechMs = active.speechFrames * FRAME_MS;
    if (speechMs < MIN_VOICED_MS)
      return {
        type: "discarded",
        reason: `Only ${speechMs} ms of speech`,
      };
    const keep = Math.min(
      active.frames.length,
      active.lastSpeechLength + Math.ceil(TRAILING_MS / FRAME_MS),
    );
    const samples = new Float32Array(keep * FRAME_SAMPLES);
    for (let i = 0; i < keep; i++)
      samples.set(active.frames[i], i * FRAME_SAMPLES);
    return {
      type: "utterance",
      samples,
      speechMs,
      overlappedPlayback: active.overlapped,
      startSample: active.startFrame * FRAME_SAMPLES,
    };
  }
}
