export type CaptureCue = "start" | "stop";

interface CueResources {
  context: AudioContext;
  oscillator: OscillatorNode | null;
  gain: GainNode | null;
  finished: Promise<void>;
  finish: () => void;
  release: () => Promise<void>;
}

const DURATION_SECONDS = 0.12;
const MAX_GAIN = 0.08;

/** Optional capture feedback; recording must never depend on cue playback. */
export class CaptureCuePlayer {
  private generation = 0;
  private current: CueResources | null = null;
  private cleanup: Promise<void> = Promise.resolve();

  async play(cue: CaptureCue, volume: number): Promise<void> {
    const generation = ++this.generation;
    const level = Number.isFinite(volume)
      ? Math.min(1, Math.max(0, volume))
      : 0;

    // Stop synchronously, then wait for closure before allocating another context.
    await this.cancelCurrent();
    if (generation !== this.generation || level === 0) return;

    const AudioContextConstructor = globalThis.AudioContext;
    if (!AudioContextConstructor) return;

    let resources: CueResources | null = null;
    try {
      const context = new AudioContextConstructor();
      let ended = false;
      let resolveFinished!: () => void;
      const finished = new Promise<void>((resolve) => {
        resolveFinished = resolve;
      });
      const finish = () => {
        ended = true;
        resolveFinished();
      };
      let release: Promise<void> | null = null;
      // A blocked resume or a later context suspension must not retain resources.
      const deadline = setTimeout(finish, 1_000);
      resources = {
        context,
        oscillator: null,
        gain: null,
        finished,
        finish,
        release: () => {
          if (release) return release;
          clearTimeout(deadline);
          finish();
          if (resources?.oscillator) {
            resources.oscillator.onended = null;
            try {
              resources.oscillator.stop();
            } catch {
              // The oscillator may already have ended or never have started.
            }
            resources.oscillator.disconnect();
          }
          resources?.gain?.disconnect();
          release = (async () => {
            try {
              if (context.state !== "closed") await context.close();
            } catch {
              // Cue cleanup is best effort when the audio backend is unavailable.
            }
          })();
          return release;
        },
      };
      this.current = resources;

      if (context.state === "suspended") {
        await Promise.race([context.resume(), finished]);
      }
      if (
        generation !== this.generation ||
        this.current !== resources ||
        ended ||
        context.state !== "running"
      )
        return;

      const oscillator = context.createOscillator();
      resources.oscillator = oscillator;
      const gain = context.createGain();
      resources.gain = gain;
      const start = context.currentTime;
      const end = start + DURATION_SECONDS;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(cue === "start" ? 520 : 780, start);
      oscillator.frequency.exponentialRampToValueAtTime(
        cue === "start" ? 780 : 520,
        end,
      );
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(MAX_GAIN * level, start + 0.015);
      gain.gain.setValueAtTime(MAX_GAIN * level, end - 0.035);
      gain.gain.linearRampToValueAtTime(0, end);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = finish;
      oscillator.start(start);
      oscillator.stop(end);
      await finished;
    } catch {
      // Missing devices and autoplay restrictions must not interrupt capture.
    } finally {
      if (resources) {
        if (this.current === resources) await this.cancelCurrent();
        else await resources.release();
      }
    }
  }

  async dispose(): Promise<void> {
    ++this.generation;
    await this.cancelCurrent();
  }

  private cancelCurrent(): Promise<void> {
    const current = this.current;
    this.current = null;
    if (current) {
      this.cleanup = Promise.all([this.cleanup, current.release()]).then(
        () => undefined,
      );
    }
    return this.cleanup;
  }
}
