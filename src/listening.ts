/**
 * Shared contracts for persistent listening sessions: a coding agent starts a
 * session once, Delulu keeps the microphone and speech model running, and the
 * agent collects one completed utterance per short waiting call.
 *
 * Delivery is at-least-once with a cursor: every event in a session has a
 * monotonically increasing `seq`. `next` returns the first event after the
 * cursor and keeps it until acknowledged. Passing `after: N` acknowledges every
 * event up to N (they are dropped), so a retried or reconnected waiter that
 * passes the same `after` gets the same event again instead of losing it.
 * See docs/SIREN.md.
 */

export type ListenSessionState =
  "starting" | "listening" | "paused" | "stopped" | "failed";

/** The user's completed utterance, transcribed. */
export type ListenUtteranceEvent = {
  seq: number;
  type: "utterance";
  sessionId: string;
  /** Stable utterance id, e.g. "utt_…". */
  id: string;
  text: string;
  at: number;
  durationMs: number;
  /** Set when this utterance interrupted a spoken response. */
  interruptedResponseId: string | null;
};

/** Delulu stopped speaking because the user started talking; a transcript follows. */
export type ListenInterruptedEvent = {
  seq: number;
  type: "interrupted";
  sessionId: string;
  /** The spoken response that was cut off (from `say --response`), if known. */
  responseId: string | null;
  at: number;
};

/** The session ended; no further events follow. */
export type ListenStoppedEvent = {
  seq: number;
  type: "stopped";
  sessionId: string;
  reason: string;
  at: number;
};

export type ListenEvent =
  ListenUtteranceEvent | ListenInterruptedEvent | ListenStoppedEvent;

export type ListenSessionInfo = {
  id: string;
  /** Who started it, e.g. "claude-code". Only that client can reuse it by name. */
  client: string;
  state: ListenSessionState;
  startedAt: number;
  /** Highest seq acknowledged; events up to it are gone. */
  ackedSeq: number;
  /** Highest seq produced so far. */
  lastSeq: number;
  /** Events after the cursor waiting to be collected. */
  queued: number;
  /** The user is speaking right now (an utterance is being captured). */
  userSpeaking: boolean;
  /** An utterance is being transcribed. */
  transcribing: boolean;
  /** Open `next` calls. */
  waiters: number;
  error: string | null;
};

export type ListenNextResult =
  | { status: "event"; event: ListenEvent; session: ListenSessionInfo }
  | { status: "timeout"; session: ListenSessionInfo }
  | { status: "stopped"; reason: string; session: ListenSessionInfo };

export const LISTEN_LIMITS = {
  /** Longest single wait; clients loop for longer. */
  maxWaitSeconds: 3_600,
  defaultWaitSeconds: 600,
  /** Unacknowledged events kept per session before the oldest are dropped. */
  queue: 200,
  /** Longest utterance before it is finalized anyway. */
  maxUtteranceMs: 60_000,
} as const;

/** Capture tuning sent from main to the renderer. */
export type ListenCaptureConfig = {
  deviceId: string;
  /** 0 (only clear, loud speech) … 1 (picks up quiet speech). */
  sensitivity: number;
  /** Quiet pause that ends an utterance. */
  silenceMs: number;
  /** Sustained speech needed before an utterance starts. */
  minSpeechMs: number;
  /** Audio kept from before speech onset so first words are not clipped. */
  preRollMs: number;
  /** Interrupt Delulu's speech when the user talks over it. */
  bargeIn: boolean;
  /** Sustained speech over playback needed to interrupt. */
  bargeInMs: number;
  maxUtteranceMs: number;
};

/** main → renderer */
export type ListenCommand =
  | { action: "start"; sessionId: string; config: ListenCaptureConfig }
  | { action: "configure"; sessionId: string; config: ListenCaptureConfig }
  /** Dictation owns the microphone; ignore audio until resumed. */
  | { action: "pause"; sessionId: string }
  | { action: "resume"; sessionId: string }
  | { action: "stop"; sessionId: string };

/** renderer → main */
export type ListenCaptureEvent =
  | {
      type: "state";
      sessionId: string;
      state: "listening" | "failed" | "stopped";
      message?: string;
    }
  /** Sustained speech began; `duringPlayback` when Delulu was talking. */
  | { type: "speechStart"; sessionId: string; duringPlayback: boolean }
  /** Sustained speech over playback: the renderer already stopped playback. */
  | { type: "bargeIn"; sessionId: string; utteranceIds: string[] }
  /** Speech-like sound that was too short to be an utterance. */
  | { type: "discarded"; sessionId: string; reason: string }
  | {
      type: "utterance";
      sessionId: string;
      /** 16 kHz mono 16-bit WAV, including the pre-roll. */
      wav: Uint8Array;
      durationMs: number;
      speechMs: number;
      /** Some of it was captured while Delulu was speaking. */
      overlappedPlayback: boolean;
    };

/** What the Voice page and tray show. */
export type ListenStatus = {
  session: ListenSessionInfo | null;
  /** Recent utterances in the current or last session, newest first. */
  recent: ListenUtteranceEvent[];
  /** Whether Delulu's microphone capture is running. */
  capturing: boolean;
  message: string;
};

/** Where the agent skill was installed. */
export type VoiceSkillInstall = { paths: string[] };
