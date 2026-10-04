/**
 * Live typing: audio streams to the speech worker while the user talks, and
 * every piece of text that becomes final is pasted at the cursor right away.
 *
 * Audio is forwarded strictly in order, and pastes are serialized and
 * coalesced, so text always lands in the order it was spoken. If the stream
 * fails, live typing stops quietly and the recording is finished normally
 * without pasting again (the caller copies the full transcript instead).
 */
export type LiveTypingPorts = {
  start: () => Promise<boolean>;
  audio: (sampleRate: number, pcm: string) => Promise<string>;
  finish: () => Promise<string>;
  /** Shape raw recognized text for delivery (personalization, rules). */
  shape: (text: string) => string;
  paste: (text: string) => Promise<unknown>;
};

export type LiveTypingResult = {
  /** Everything the model recognized, unshaped. */
  raw: string;
  /** Text that was sent to the cursor. */
  typed: string;
  /** Set when live typing stopped early; nothing more was pasted after it. */
  failure: string | null;
};

export class LiveTyping {
  private started: Promise<boolean>;
  private audioChain: Promise<void> = Promise.resolve();
  private audioQueue: { sampleRate: number; pcm: string }[] = [];
  private queuedBytes = 0;
  private drainingAudio = false;
  private pasteChain: Promise<void> = Promise.resolve();
  private drainingPaste = false;
  private inFlightText = "";
  private attemptedPaste = false;
  private closing: Promise<string> | null = null;
  private pendingText = "";
  private raw = "";
  private typed = "";
  private failure: string | null = null;
  private stopped = false;

  constructor(private readonly ports: LiveTypingPorts) {
    this.started = ports.start().catch(() => false);
  }

  /** False once live typing gave up; the caller then falls back to buffered delivery. */
  get healthy(): boolean {
    return this.failure === null;
  }

  /** A failed native paste may already have inserted some characters. */
  get deliveryAttempted(): boolean {
    return this.attemptedPaste;
  }

  audio(sampleRate: number, pcm: string): void {
    if (this.stopped || this.failure) return;
    // About five seconds at the renderer's 200 ms cadence. Stop streaming
    // rather than retaining a recording's worth of closures behind a slow GPU.
    if (
      this.audioQueue.length >= 25 ||
      this.queuedBytes + pcm.length > 4 * 1024 * 1024
    ) {
      this.fail(
        new Error(
          "Live recognition fell behind; finishing from the full recording",
        ),
      );
      return;
    }
    this.audioQueue.push({ sampleRate, pcm });
    this.queuedBytes += pcm.length;
    if (this.drainingAudio) return;
    this.drainingAudio = true;
    this.audioChain = this.drainAudio();
  }

  private async drainAudio(): Promise<void> {
    try {
      if (!(await this.started)) {
        this.fail(new Error("Live typing could not start"));
        return;
      }
      while (!this.failure && this.audioQueue.length) {
        const { sampleRate, pcm } = this.audioQueue.shift()!;
        this.queuedBytes -= pcm.length;
        this.receive(await this.ports.audio(sampleRate, pcm));
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.drainingAudio = false;
    }
  }

  private receive(delta: string): void {
    if (!delta || this.failure) return;
    this.raw += delta;
    // Keep the speaker's spacing exactly; rules only reshape the words.
    const lead = delta.match(/^\s*/)?.[0] ?? "";
    const trail = delta.slice(lead.length).match(/\s*$/)?.[0] ?? "";
    const body = delta.slice(lead.length, delta.length - trail.length);
    if (!body) return;
    const before = this.typed + this.inFlightText + this.pendingText;
    const separator =
      lead ||
      (before && !/\s$/.test(before) && /^[\p{L}\p{N}]/u.test(body) ? " " : "");
    this.queuePaste(separator + this.ports.shape(body) + trail);
  }

  private queuePaste(text: string): void {
    if (!text.trim()) return;
    this.pendingText += text;
    if (this.drainingPaste) return;
    this.drainingPaste = true;
    this.pasteChain = this.drainPaste();
  }

  private async drainPaste(): Promise<void> {
    try {
      while (this.pendingText && !this.failure) {
        // Coalesce whatever arrived while the previous paste was running.
        this.inFlightText = this.pendingText;
        this.pendingText = "";
        this.attemptedPaste = true;
        await this.ports.paste(this.inFlightText);
        this.typed += this.inFlightText;
        this.inFlightText = "";
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.inFlightText = "";
      this.drainingPaste = false;
    }
  }

  private fail(error: unknown): void {
    this.failure ??= (error instanceof Error ? error.message : String(error))
      .split(/\r?\n/)[0]
      .slice(0, 200);
    this.audioQueue = [];
    this.queuedBytes = 0;
    this.pendingText = "";
  }

  private closeStream(): Promise<string> {
    return (this.closing ??= this.started.then((started) =>
      started ? this.ports.finish() : "",
    ));
  }

  async finish(): Promise<LiveTypingResult> {
    this.stopped = true;
    await this.audioChain;
    try {
      // Close even a failed stream before the buffered fallback uses its worker.
      this.receive(await this.closeStream());
    } catch (error) {
      this.fail(error);
    }
    if (!(await this.started)) {
      this.fail(new Error("Live typing could not start"));
    }
    await this.pasteChain;
    return { raw: this.raw.trim(), typed: this.typed, failure: this.failure };
  }

  /** Drop the session without pasting anything else. */
  async cancel(): Promise<void> {
    this.stopped = true;
    this.fail(new Error("cancelled"));
    await this.audioChain.catch(() => undefined);
    await this.closeStream().catch(() => undefined);
    await this.pasteChain;
  }
}
