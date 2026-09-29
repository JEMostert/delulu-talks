import type { DictationStatus, MagicStatus, TranscriptRecord } from "./types";

/** External event permissions are separate from the trusted renderer IPC API. */
export type IntegrationEventCapability = "events:status" | "transcripts:read";
export type IntegrationEventGrant = {
  active: boolean;
  capabilities: readonly IntegrationEventCapability[];
};
export type IntegrationEventInput =
  | { kind: "speech-status"; status: DictationStatus }
  | { kind: "rewrite-status"; status: MagicStatus }
  | { kind: "transcript-available"; record: TranscriptRecord };
export type IntegrationEventPayload =
  | {
      schemaVersion: 1;
      kind: "speech-status";
      phase: DictationStatus["phase"];
      engine: DictationStatus["engine"];
      retryAvailable: boolean;
    }
  | {
      schemaVersion: 1;
      kind: "rewrite-status";
      phase: MagicStatus["phase"];
      engine: MagicStatus["engine"];
    }
  | {
      schemaVersion: 1;
      kind: "transcript-available";
      id: string;
      createdAt: number;
      model: TranscriptRecord["model"];
      source: TranscriptRecord["source"];
      content?: {
        original: string;
        personalized: string | null;
        corrected: string | null;
        rewritten: string | null;
      };
    };

/**
 * Call immediately before external delivery with a fresh permission lookup.
 * No raw event/object spread: messages, detail, filenames, paths and future
 * fields are excluded even when transcript-content access was granted.
 */
export function integrationEventPayload(
  input: IntegrationEventInput,
  currentGrant: () => IntegrationEventGrant | null,
): IntegrationEventPayload | null {
  const grant = currentGrant();
  if (!grant?.active || !grant.capabilities.includes("events:status")) return null;
  if (input.kind === "speech-status") {
    return {
      schemaVersion: 1,
      kind: input.kind,
      phase: input.status.phase,
      engine: input.status.engine,
      retryAvailable: input.status.retryAvailable === true,
    };
  }
  if (input.kind === "rewrite-status") {
    return {
      schemaVersion: 1,
      kind: input.kind,
      phase: input.status.phase,
      engine: input.status.engine,
    };
  }
  const { record } = input;
  const payload: IntegrationEventPayload = {
    schemaVersion: 1,
    kind: input.kind,
    id: record.id,
    createdAt: record.createdAt,
    model: record.model,
    source: record.source,
  };
  if (grant.capabilities.includes("transcripts:read")) {
    payload.content = {
      original: record.text,
      personalized: record.personalizedText ?? null,
      corrected: record.editedText ?? null,
      rewritten: record.magicText ?? null,
    };
  }
  return payload;
}
