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
  private pasteChain: Promise<void> = Promise.resolve();
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

  audio(sampleRate: number, pcm: string): void {
    if (this.stopped) return;
    this.audioChain = this.audioChain.then(async () => {
      if (this.failure || !(await this.started)) return;
      try {
        this.receive(await this.ports.audio(sampleRate, pcm));
      } catch (error) {
        this.fail(error);
      }
    });
  }

  private receive(delta: string): void {
    if (!delta) return;
    this.raw += delta;
    // Keep the speaker's spacing exactly; rules only reshape the words.
    const lead = delta.match(/^\s*/)?.[0] ?? "";
    const trail = delta.slice(lead.length).match(/\s*$/)?.[0] ?? "";
    const body = delta.slice(lead.length, delta.length - trail.length);
    if (!body) return;
    const before = this.typed + this.pendingText;
    const separator =
      lead ||
      (before && !/\s$/.test(before) && /^[\p{L}\p{N}]/u.test(body) ? " " : "");
    this.queuePaste(separator + this.ports.shape(body) + trail);
  }

  private queuePaste(text: string): void {
    if (!text.trim()) return;
    this.pendingText += text;
    this.pasteChain = this.pasteChain.then(async () => {
      // Coalesce whatever arrived while the previous paste was running.
      const next = this.pendingText;
      this.pendingText = "";
      if (!next || this.failure) return;
      try {
        await this.ports.paste(next);
        this.typed += next;
      } catch (error) {
        this.fail(error);
      }
    });
  }

  private fail(error: unknown): void {
    this.failure ??= (error instanceof Error ? error.message : String(error))
      .split(/\r?\n/)[0]
      .slice(0, 200);
  }

  async finish(): Promise<LiveTypingResult> {
    this.stopped = true;
    await this.audioChain;
    if (!this.failure && (await this.started)) {
      try {
        this.receive(await this.ports.finish());
      } catch (error) {
        this.fail(error);
      }
    } else if (!(await this.started)) {
      this.fail(new Error("Live typing could not start"));
    }
    await this.pasteChain;
    return { raw: this.raw.trim(), typed: this.typed, failure: this.failure };
  }

  /** Drop the session without pasting anything else. */
  async cancel(): Promise<void> {
    this.stopped = true;
    this.failure ??= "cancelled";
    await this.audioChain.catch(() => undefined);
    if (await this.started) await this.ports.finish().catch(() => undefined);
  }
}
