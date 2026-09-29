import { expect, test } from "bun:test";
import { integrationEventPayload, type IntegrationEventGrant } from "./integrationEvents";
import type { TranscriptRecord } from "./types";

const record: TranscriptRecord = {
  id: "event-fixture", createdAt: 1, durationMs: 200,
  text: "Private original speech", personalizedText: "Private personalized speech",
  editedText: "Private correction", magicText: "Private rewrite",
  model: "r2t2", language: "nl", source: "file",
  sourceName: "/private/recordings/personal.wav", processingTimeMs: 10,
};
const event = { kind: "transcript-available", record } as const;

test("status subscription never includes transcript variants, paths or future fields", () => {
  const payload = integrationEventPayload({ ...event, record: { ...record, extraSecret: "sensitive future field" } as TranscriptRecord }, () => ({ active: true, capabilities: ["events:status"] }));
  expect(payload).toEqual({ schemaVersion: 1, kind: "transcript-available", id: "event-fixture", createdAt: 1, model: "r2t2", source: "file" });
});

test("transcript permission grants explicit variants without exposing filenames", () => {
  const payload = integrationEventPayload(event, () => ({ active: true, capabilities: ["events:status", "transcripts:read"] }));
  expect(payload).toEqual({ schemaVersion: 1, kind: "transcript-available", id: "event-fixture", createdAt: 1, model: "r2t2", source: "file", content: { original: record.text, personalized: record.personalizedText, corrected: record.editedText, rewritten: record.magicText } });
});

test("permission is checked at each projection after revocation", () => {
  let grant: IntegrationEventGrant | null = { active: true, capabilities: ["events:status", "transcripts:read"] };
  expect(integrationEventPayload(event, () => grant)).not.toBeNull();
  grant = { active: false, capabilities: ["events:status", "transcripts:read"] };
  expect(integrationEventPayload(event, () => grant)).toBeNull();
  grant = null;
  expect(integrationEventPayload(event, () => grant)).toBeNull();
});

test("transcript permission alone does not authorize event delivery", () => {
  expect(integrationEventPayload(event, () => ({ active: true, capabilities: ["transcripts:read"] }))).toBeNull();
});

test("worker errors cannot leak source content through status messages", () => {
  const grant = () => ({ active: true, capabilities: ["events:status"] as const });
  const speech = integrationEventPayload({ kind: "speech-status", status: { phase: "error", engine: "error", message: record.text, detail: record.sourceName, retryAvailable: true } }, grant);
  expect(speech).toEqual({ schemaVersion: 1, kind: "speech-status", phase: "error", engine: "error", retryAvailable: true });
  const rewriting = integrationEventPayload({ kind: "rewrite-status", status: { phase: "error", engine: "error", message: record.magicText!, detail: record.sourceName } }, grant);
  expect(rewriting).toEqual({ schemaVersion: 1, kind: "rewrite-status", phase: "error", engine: "error" });
});
