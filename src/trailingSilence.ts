export interface TrailingSilenceUpdate {
  remainingSeconds: number | null;
  shouldStop: boolean;
}

// This is a packet energy heuristic, not calibrated speech detection. It reads
// raw PCM without altering it, and measures elapsed audio rather than wall time.
export class TrailingSilenceStop {
  private readonly seconds: number;
  private readonly threshold: number;
  private armed = false;
  private activityMs = 0;
  private quietMs = 0;
  private stopped = false;
  private remainingSeconds: number | null = null;

  constructor(seconds: number, thresholdDb: number) {
    this.seconds = Math.min(
      30,
      Math.max(2, Number.isFinite(seconds) ? seconds : 5),
    );
    const db = Math.min(
      -20,
      Math.max(-60, Number.isFinite(thresholdDb) ? thresholdDb : -45),
    );
    this.threshold = 10 ** (db / 20);
  }

  reset(): void {
    this.armed = false;
    this.activityMs = 0;
    this.quietMs = 0;
    this.stopped = false;
    this.remainingSeconds = null;
  }

  update(samples: Float32Array, sampleRate: number): TrailingSilenceUpdate {
    if (this.stopped) return { remainingSeconds: 0, shouldStop: false };
    if (!samples.length || !Number.isFinite(sampleRate) || sampleRate <= 0)
      return { remainingSeconds: this.remainingSeconds, shouldStop: false };
    const durationMs = (samples.length / sampleRate) * 1000;
    if (!Number.isFinite(durationMs))
      return { remainingSeconds: this.remainingSeconds, shouldStop: false };

    let energy = 0;
    for (const sample of samples) {
      if (!Number.isFinite(sample)) {
        // Unknown input is neither silence nor evidence for arming.
        this.activityMs = 0;
        this.quietMs = 0;
        this.remainingSeconds = null;
        return { remainingSeconds: null, shouldStop: false };
      }
      energy += sample * sample;
    }
    const rms = Math.sqrt(energy / samples.length);
    if (rms > this.threshold) {
      this.activityMs += durationMs;
      if (this.activityMs >= 150) this.armed = true;
      this.quietMs = 0;
      this.remainingSeconds = null;
      return { remainingSeconds: null, shouldStop: false };
    }

    this.activityMs = 0;
    if (!this.armed) return { remainingSeconds: null, shouldStop: false };
    this.quietMs += durationMs;
    if (this.quietMs >= this.seconds * 1000) {
      this.stopped = true;
      this.remainingSeconds = 0;
      return { remainingSeconds: 0, shouldStop: true };
    }
    this.remainingSeconds = Math.ceil(this.seconds - this.quietMs / 1000);
    return { remainingSeconds: this.remainingSeconds, shouldStop: false };
  }
}
