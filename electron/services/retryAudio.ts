import type { RecordingSubmission, RetryAudioState } from "../../src/types";

export interface RetryAudioLease {
  readonly recording: RecordingSubmission;
  discarded: boolean;
}

/** Owns only session-memory audio; callers own native inference file cleanup. */
export class RetryAudioStore {
  private pending: RecordingSubmission | null = null;
  private active: RetryAudioLease | null = null;
  private discarded = false;
  private disposed = false;

  get available(): boolean {
    return this.pending !== null;
  }

  get state(): RetryAudioState {
    const recording = this.active?.recording ?? this.pending;
    return {
      phase: this.active ? "retrying" : this.pending ? "available" : "empty",
      byteLength: recording?.wav.byteLength ?? 0,
      durationMs: recording?.durationMs ?? null,
      discarded: this.active?.discarded ?? this.discarded,
      sessionOnly: true,
    };
  }

  retain(recording: RecordingSubmission): boolean {
    if (this.disposed) return false;
    let owned: RecordingSubmission;
    try {
      if (
        !(recording.wav instanceof Uint8Array) ||
        recording.wav.byteLength === 0 ||
        !Number.isFinite(recording.durationMs) ||
        recording.durationMs < 0
      )
        return false;
      owned = {
        ...recording,
        // Constructing a Uint8Array copies even when the input is a Node Buffer.
        wav: new Uint8Array(recording.wav),
      };
    } catch {
      return false;
    }
    this.clearAvailable();
    this.pending = owned;
    this.discarded = false;
    return true;
  }

  beginRetry(): RetryAudioLease | null {
    if (this.disposed || this.active || !this.pending) return null;
    const lease: RetryAudioLease = {
      recording: this.pending,
      discarded: false,
    };
    this.pending = null;
    this.active = lease;
    return lease;
  }

  finishRetry(lease: RetryAudioLease, failed: boolean): void {
    if (this.disposed || this.active !== lease) return;
    this.active = null;
    if (failed && !lease.discarded && !this.pending) {
      this.pending = lease.recording;
      this.discarded = false;
      return;
    }
    this.wipe(lease.recording);
    if (!this.pending) this.discarded = lease.discarded;
  }

  clearAvailable(): void {
    if (this.pending) this.wipe(this.pending);
    this.pending = null;
  }

  discard(): void {
    this.clearAvailable();
    if (this.active) {
      this.active.discarded = true;
      this.wipe(this.active.recording);
    }
    this.discarded = true;
  }

  dispose(): void {
    this.discard();
    this.active = null;
    this.disposed = true;
  }

  private wipe(recording: RecordingSubmission): void {
    try {
      recording.wav.fill(0);
    } catch {
      // A detached buffer is already unavailable; still release the reference.
    }
    recording.wav = new Uint8Array(0);
  }
}
