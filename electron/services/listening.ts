import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LISTEN_LIMITS,
  type ListenCaptureConfig,
  type ListenCaptureEvent,
  type ListenCommand,
  type ListenEvent,
  type ListenNextResult,
  type ListenSessionInfo,
  type ListenSessionState,
  type ListenStatus,
  type ListenUtteranceEvent,
} from "../../src/listening";
import type { AppSettings } from "../../src/types";
import { SerialQueue } from "../runtime/serialQueue";

/** The parts of the speech and voice services a listening session uses. */
export type ListeningDependencies = {
  settings(): AppSettings;
  cacheDirectory: string;
  /** Whether the speech runtime can transcribe; loads the model. */
  prepareSpeech(settings: AppSettings): Promise<void>;
  transcribe(audioPath: string, durationMs: number): Promise<string>;
  /** Stop Delulu talking; returns the response ids that were cut off. */
  interruptSpeech(): string[];
  /** Text Delulu said recently, to recognize its own voice. */
  recentlySpoken(): string[];
  /** Send a command to the renderer that owns the microphone. */
  command(command: ListenCommand): boolean;
};

export class ListenError extends Error {
  constructor(
    readonly code: "SESSION_BUSY" | "SESSION_NOT_FOUND" | "UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "ListenError";
  }
}

type Waiter = {
  resolve: (result: ListenNextResult) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
};

type Session = {
  id: string;
  client: string;
  state: ListenSessionState;
  startedAt: number;
  events: ListenEvent[];
  ackedSeq: number;
  lastSeq: number;
  waiters: Set<Waiter>;
  userSpeaking: boolean;
  transcribing: number;
  error: string | null;
  /** The response a barge-in cut off, until the user's utterance arrives. */
  interruptedResponseId: string | null;
  /** Dictation owns the microphone for now. */
  pausedForDictation: boolean;
  transcriptions: SerialQueue;
};

const RECENT_UTTERANCES = 20;
// Sounds people make while thinking or that recognizers emit for noise.
const NOT_A_TURN = new Set([
  "",
  "uh",
  "um",
  "hm",
  "hmm",
  "mm",
  "mhm",
  "ah",
  "oh",
  "eh",
  "er",
  "huh",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Whether a transcript is mostly words Delulu itself just said. */
export function soundsLikeOwnSpeech(text: string, spoken: string[]): boolean {
  const heard = words(text);
  if (heard.length < 2) return false;
  for (const said of spoken) {
    const vocabulary = new Set(words(said));
    const matched = heard.filter((word) => vocabulary.has(word)).length;
    if (matched / heard.length >= 0.7) return true;
  }
  return false;
}

/** Whether a transcript carries an actual turn rather than noise or a filler. */
export function isRealTurn(text: string): boolean {
  const heard = words(text);
  if (!heard.length) return false;
  return !heard.every((word) => NOT_A_TURN.has(word));
}

/**
 * Persistent listening sessions. The app owns the microphone, the speech model
 * and the transcript queue; agents collect events with short `next` calls that
 * can time out, be cancelled or be retried without losing anything.
 */
export class ListeningService {
  private session: Session | null = null;
  private recent: ListenUtteranceEvent[] = [];
  private capturing = false;
  private readonly listeners = new Set<(status: ListenStatus) => void>();

  constructor(private readonly dependencies: ListeningDependencies) {}

  onStatus(listener: (status: ListenStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A session is running and keeps the speech model loaded. */
  get active(): boolean {
    return (
      !!this.session &&
      ["starting", "listening", "paused"].includes(this.session.state)
    );
  }

  getStatus(): ListenStatus {
    const session = this.session;
    return {
      session: session ? this.info(session) : null,
      recent: structuredClone(this.recent),
      capturing: this.capturing,
      message: !session
        ? "Not listening"
        : session.state === "listening"
          ? session.userSpeaking
            ? "Hearing you…"
            : session.transcribing
              ? "Transcribing…"
              : "Listening"
          : session.state === "paused"
            ? "Paused while you dictate"
            : session.state === "starting"
              ? "Starting the microphone…"
              : session.state === "failed"
                ? (session.error ?? "Listening failed")
                : "Stopped",
    };
  }

  private info(session: Session): ListenSessionInfo {
    return {
      id: session.id,
      client: session.client,
      state: session.state,
      startedAt: session.startedAt,
      ackedSeq: session.ackedSeq,
      lastSeq: session.lastSeq,
      queued: session.events.filter((event) => event.seq > session.ackedSeq)
        .length,
      userSpeaking: session.userSpeaking,
      transcribing: session.transcribing > 0,
      waiters: session.waiters.size,
      error: session.error,
    };
  }

  private publish(): void {
    const status = this.getStatus();
    for (const listener of this.listeners) listener(status);
  }

  private config(settings: AppSettings): ListenCaptureConfig {
    return {
      deviceId: settings.inputDeviceId || "default",
      sensitivity: settings.listenSensitivity,
      silenceMs: settings.listenSilenceMs,
      minSpeechMs: 200,
      preRollMs: 500,
      bargeIn: settings.listenBargeIn,
      bargeInMs: settings.listenBargeInMs,
      maxUtteranceMs: LISTEN_LIMITS.maxUtteranceMs,
    };
  }

  private find(sessionId: string): Session {
    if (this.session?.id !== sessionId)
      throw new ListenError(
        "SESSION_NOT_FOUND",
        "That listening session does not exist. Start a new one with listen start.",
      );
    return this.session;
  }

  /** Start listening, or return the running session started by this client. */
  async start(client: string): Promise<ListenSessionInfo> {
    const name = client.trim().slice(0, 64) || "agent";
    const current = this.session;
    if (current && this.active) {
      if (current.client === name) return this.info(current);
      throw new ListenError(
        "SESSION_BUSY",
        `Delulu is already listening for ${current.client}. Stop that session first; one microphone serves one conversation.`,
      );
    }
    const settings = this.dependencies.settings();
    const session: Session = {
      id: `lsn_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      client: name,
      state: "starting",
      startedAt: Date.now(),
      events: [],
      ackedSeq: 0,
      lastSeq: 0,
      waiters: new Set(),
      userSpeaking: false,
      transcribing: 0,
      error: null,
      interruptedResponseId: null,
      pausedForDictation: false,
      transcriptions: new SerialQueue(),
    };
    this.session = session;
    this.recent = [];
    this.publish();
    try {
      // Load the speech model once; it stays loaded while the session runs.
      await this.dependencies.prepareSpeech(settings);
    } catch (error) {
      this.fail(
        session,
        error instanceof Error ? error.message : "Speech is unavailable",
      );
      throw new ListenError("UNAVAILABLE", session.error!);
    }
    if (this.session !== session || session.state !== "starting")
      return this.info(session);
    if (
      !this.dependencies.command({
        action: "start",
        sessionId: session.id,
        config: this.config(settings),
      })
    ) {
      this.fail(session, "Open Delulu Talks so it can use the microphone.");
      throw new ListenError("UNAVAILABLE", session.error!);
    }
    return this.info(session);
  }

  /** Wait for the next event after the cursor; `after` acknowledges up to it. */
  next(
    sessionId: string,
    options: { after?: number; timeoutMs: number; signal?: AbortSignal },
  ): Promise<ListenNextResult> {
    const session = this.find(sessionId);
    if (options.after !== undefined) this.acknowledge(session, options.after);
    const pending = session.events.find(
      (event) => event.seq > session.ackedSeq,
    );
    if (pending)
      return Promise.resolve({
        status: "event",
        event: pending,
        session: this.info(session),
      });
    if (session.state === "stopped" || session.state === "failed")
      return Promise.resolve({
        status: "stopped",
        reason: session.error ?? "The listening session ended",
        session: this.info(session),
      });
    const timeoutMs = Math.max(
      0,
      Math.min(options.timeoutMs, LISTEN_LIMITS.maxWaitSeconds * 1000),
    );
    if (!timeoutMs || options.signal?.aborted)
      return Promise.resolve({
        status: "timeout",
        session: this.info(session),
      });
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve: (result) => {
          waiter.cleanup();
          resolve(result);
        },
        timer: setTimeout(
          () =>
            waiter.resolve({ status: "timeout", session: this.info(session) }),
          timeoutMs,
        ),
        cleanup: () => {
          clearTimeout(waiter.timer);
          options.signal?.removeEventListener("abort", abort);
          session.waiters.delete(waiter);
          this.publish();
        },
      };
      // A cancelled waiter leaves its event queued for the next one.
      const abort = () =>
        waiter.resolve({ status: "timeout", session: this.info(session) });
      options.signal?.addEventListener("abort", abort, { once: true });
      session.waiters.add(waiter);
      this.publish();
    });
  }

  ack(sessionId: string, after: number): ListenSessionInfo {
    const session = this.find(sessionId);
    this.acknowledge(session, after);
    this.publish();
    return this.info(session);
  }

  private acknowledge(session: Session, after: number): void {
    const cursor = Math.min(Math.max(0, Math.floor(after)), session.lastSeq);
    if (cursor <= session.ackedSeq) return;
    session.ackedSeq = cursor;
    session.events = session.events.filter((event) => event.seq > cursor);
  }

  status(sessionId?: string): ListenSessionInfo | null {
    if (sessionId) return this.info(this.find(sessionId));
    return this.session ? this.info(this.session) : null;
  }

  async stop(
    sessionId: string,
    reason = "Stopped by request",
  ): Promise<ListenSessionInfo> {
    const session = this.find(sessionId);
    this.end(session, "stopped", reason);
    return this.info(session);
  }

  /** Stop whatever session is running (Voice page, tray, quitting). */
  stopActive(reason = "Stopped in Delulu Talks"): void {
    if (this.session && this.active) this.end(this.session, "stopped", reason);
  }

  private end(
    session: Session,
    state: "stopped" | "failed",
    reason: string,
  ): void {
    if (session.state === "stopped" || session.state === "failed") return;
    session.state = state;
    session.userSpeaking = false;
    if (state === "failed") session.error = reason;
    this.dependencies.command({ action: "stop", sessionId: session.id });
    this.capturing = false;
    this.push(session, {
      type: "stopped",
      sessionId: session.id,
      reason,
      at: Date.now(),
    });
  }

  private fail(session: Session, message: string): void {
    this.end(session, "failed", message);
  }

  private push(
    session: Session,
    event:
      | Omit<ListenUtteranceEvent, "seq">
      | Omit<Extract<ListenEvent, { type: "interrupted" }>, "seq">
      | Omit<Extract<ListenEvent, { type: "stopped" }>, "seq">,
  ): void {
    const full = { ...event, seq: ++session.lastSeq } as ListenEvent;
    session.events.push(full);
    // Bound memory; acknowledged events are already gone.
    const unacked = session.events.filter(
      (item) => item.seq > session.ackedSeq,
    );
    if (unacked.length > LISTEN_LIMITS.queue) {
      const drop = unacked[0].seq;
      session.events = session.events.filter((item) => item.seq !== drop);
    }
    if (full.type === "utterance")
      this.recent = [full, ...this.recent].slice(0, RECENT_UTTERANCES);
    // Every waiter gets the first event after the shared cursor.
    const first = session.events.find((item) => item.seq > session.ackedSeq);
    for (const waiter of [...session.waiters])
      if (first)
        waiter.resolve({
          status: "event",
          event: first,
          session: this.info(session),
        });
    this.publish();
  }

  /* -------------------------------------------------------------- */
  /* Capture events from the renderer                                */
  /* -------------------------------------------------------------- */

  captureEvent(event: ListenCaptureEvent): void {
    const session = this.session;
    if (!session || session.id !== event.sessionId) return;
    if (session.state === "stopped" || session.state === "failed") return;
    switch (event.type) {
      case "state":
        if (event.state === "listening") {
          session.state = session.pausedForDictation ? "paused" : "listening";
          session.error = null;
          this.capturing = true;
        } else if (event.state === "failed") {
          this.capturing = false;
          this.fail(session, event.message ?? "The microphone stopped");
        }
        break;
      case "speechStart":
        session.userSpeaking = true;
        break;
      case "discarded":
        session.userSpeaking = false;
        break;
      case "bargeIn": {
        // The renderer already silenced playback; cancel synthesis and the queue.
        const responses = this.dependencies.interruptSpeech();
        const responseId = responses[0] ?? null;
        session.userSpeaking = true;
        session.interruptedResponseId = responseId;
        this.push(session, {
          type: "interrupted",
          sessionId: session.id,
          responseId,
          at: Date.now(),
        });
        return;
      }
      case "utterance":
        session.userSpeaking = false;
        this.transcribe(session, event);
        break;
    }
    this.publish();
  }

  private transcribe(
    session: Session,
    event: Extract<ListenCaptureEvent, { type: "utterance" }>,
  ): void {
    session.transcribing += 1;
    const interruptedResponseId = session.interruptedResponseId;
    session.interruptedResponseId = null;
    // Transcribe in order so turns arrive as spoken.
    void session.transcriptions.run(async () => {
      const directory = this.dependencies.cacheDirectory;
      const path = join(
        directory,
        `dictation-${Date.now()}-${randomUUID()}.wav`,
      );
      try {
        mkdirSync(directory, { recursive: true });
        writeFileSync(path, event.wav, { mode: 0o600 });
        const text = (
          await this.dependencies.transcribe(path, event.durationMs)
        ).trim();
        if (!this.active || this.session !== session) return;
        if (!isRealTurn(text)) return;
        if (
          !interruptedResponseId &&
          soundsLikeOwnSpeech(text, this.dependencies.recentlySpoken())
        )
          return;
        session.error = null;
        this.push(session, {
          type: "utterance",
          sessionId: session.id,
          id: `utt_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
          text,
          at: Date.now(),
          durationMs: Math.round(event.durationMs),
          interruptedResponseId,
        });
      } catch (error) {
        // One failed transcription does not end the conversation.
        session.error =
          error instanceof Error
            ? `Could not transcribe that: ${error.message}`
            : "Could not transcribe that";
      } finally {
        rmSync(path, { force: true });
        session.transcribing -= 1;
        this.publish();
      }
    });
  }

  /* -------------------------------------------------------------- */
  /* Coordination                                                    */
  /* -------------------------------------------------------------- */

  /** Dictation is about to open the microphone. */
  pauseForDictation(): void {
    const session = this.session;
    if (!session || !this.active || session.pausedForDictation) return;
    session.pausedForDictation = true;
    session.state = "paused";
    this.dependencies.command({ action: "pause", sessionId: session.id });
    this.publish();
  }

  /** Dictation finished. */
  resumeAfterDictation(): void {
    const session = this.session;
    if (!session || !session.pausedForDictation) return;
    session.pausedForDictation = false;
    if (session.state !== "paused") return;
    session.state = "listening";
    this.dependencies.command({ action: "resume", sessionId: session.id });
    this.publish();
  }

  /** Listening settings changed; apply them to the running capture. */
  settingsChanged(settings: AppSettings): void {
    const session = this.session;
    if (!session || !this.active) return;
    this.dependencies.command({
      action: "configure",
      sessionId: session.id,
      config: this.config(settings),
    });
  }

  /** The renderer reloaded; restart capture for the running session. */
  rendererReady(): void {
    const session = this.session;
    this.capturing = false;
    if (!session || !this.active) return;
    session.state = session.pausedForDictation ? "paused" : "starting";
    session.userSpeaking = false;
    this.dependencies.command({
      action: "start",
      sessionId: session.id,
      config: this.config(this.dependencies.settings()),
    });
    if (session.pausedForDictation)
      this.dependencies.command({ action: "pause", sessionId: session.id });
    this.publish();
  }

  shutdown(): void {
    this.stopActive("Delulu Talks closed");
  }
}
