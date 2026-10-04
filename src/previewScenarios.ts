import type {
  DictationStatus,
  MagicStatus,
  TranscriptRecord,
  UpdateStatus,
} from "./types";

/** Design-preview states, chosen with `?scenario=` in the browser preview. */
export const previewScenario =
  typeof location === "undefined"
    ? null
    : new URLSearchParams(location.search).get("scenario");

const minute = 60_000;
const day = 24 * 60 * minute;

export function scenarioStatus(): DictationStatus {
  const base = { model: "r2t2" as const, capabilities: null };
  switch (previewScenario) {
    case "recording":
      return {
        ...base,
        phase: "listening",
        engine: "ready",
        message: "Listening — press the shortcut again to finish",
      };
    case "transcribing":
      return {
        ...base,
        phase: "transcribing",
        engine: "ready",
        message: "Transcribing locally",
      };
    case "setup":
      return {
        ...base,
        phase: "idle",
        engine: "missing",
        message: "Speech runtime setup required",
      };
    case "error":
      return {
        ...base,
        phase: "error",
        engine: "ready",
        message: "The speech model worker stopped unexpectedly.",
        retryAvailable: true,
      };
    default:
      return {
        ...base,
        phase: "idle",
        engine: "ready",
        message: "Ready",
      };
  }
}

export function scenarioMagicStatus(): MagicStatus {
  return {
    phase: "idle",
    engine: previewScenario === "setup" ? "missing" : "ready",
    message: "Rewriting ready (Qwen 3.5 · 2B)",
    model: "qwen35Medium",
    device: "cuda",
  };
}

export function scenarioUpdateStatus(): UpdateStatus {
  return previewScenario === "update"
    ? {
        phase: "downloaded",
        currentVersion: "0.11.0",
        version: "0.11.1",
        message: "Update downloaded",
      }
    : {
        phase: "unsupported",
        currentVersion: "browser",
        message: "Updates are available in the installed app",
      };
}

/** A believable spread of history for layout review. */
export function scenarioHistory(now = Date.now()): TranscriptRecord[] {
  const record = (
    id: string,
    age: number,
    text: string,
    patch: Partial<TranscriptRecord> = {},
  ): TranscriptRecord => ({
    id,
    createdAt: now - age,
    durationMs: Math.max(3000, text.length * 55),
    text,
    model: "r2t2",
    language: "en",
    requestedLanguage: "en",
    recognizedLanguage: "en",
    source: "dictation",
    processingTimeMs: 900,
    delivery: { state: "confirmed", updatedAt: now - age },
    ...patch,
  });
  return [
    record(
      "demo-2",
      4 * minute,
      "Hey Sam, quick update on the onboarding flow. The new welcome screen is ready for review, and I moved the permissions step after the first dictation so people hear the result before we ask for anything.",
      {
        magicText:
          "Hi Sam, a quick update on onboarding: the new welcome screen is ready for review. I moved the permissions step after the first dictation, so people hear a result before we ask for anything.",
        magicModel: "qwen35Medium",
        magicPreset: "polish",
        title: "Onboarding update for Sam",
      },
    ),
    record(
      "demo-3",
      42 * minute,
      "const total equals items dot reduce open paren sum comma item close paren",
      {
        dictationMode: "code",
        technicalText: "const total = items.reduce(sum, item)",
      },
    ),
    record(
      "demo-1",
      3 * 60 * minute,
      "Move the design review to Thursday and add the new onboarding notes.",
      {
        editedText:
          "Move the design review to Thursday and add the new onboarding notes for Maya.",
      },
    ),
    record(
      "demo-4",
      day + 2 * 60 * minute,
      "Notulen van het teamoverleg: we leveren de nieuwe versie vrijdag op en plannen daarna een korte retrospective.",
      { language: "nl", requestedLanguage: "nl", recognizedLanguage: "nl" },
    ),
    record(
      "demo-5",
      3 * day,
      "Interview with the product team about local-first dictation, privacy expectations and how corrections should feel when they are applied automatically.",
      {
        source: "file",
        sourceName: "product-interview.m4a",
        durationMs: 14 * minute,
        delivery: { state: "transcribed", updatedAt: now - 3 * day },
      },
    ),
  ];
}
