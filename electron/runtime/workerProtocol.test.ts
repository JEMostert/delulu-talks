import { expect, test } from "bun:test";
import { MAX_RECOGNITION_HINT_CHARS } from "../../src/recognitionHints";
import {
  BoundedWorkerLines,
  WorkerDiagnosticTail,
  serializeWorkerRequest,
  validateWorkerRequest,
  validateWorkerResult,
} from "./workerProtocol";

test("worker framing preserves fragmented Unicode and final output while bounding unterminated logs", () => {
  const parser = new BoundedWorkerLines(32);
  const lines: string[] = [];
  const receive = (line: string) => {
    lines.push(line);
    return true;
  };
  for (const byte of Buffer.from("café 🎙️\r\nfinal"))
    parser.push(Buffer.from([byte]), receive);
  parser.end(receive);
  expect(lines).toEqual(["café 🎙️", "final"]);
  const runaway = new BoundedWorkerLines(4);
  runaway.push(Buffer.from("1234"), receive);
  expect(() => runaway.push(Buffer.from("5"), receive)).toThrow("exceeds 4");
  const diagnostics = new WorkerDiagnosticTail(7);
  for (const byte of Buffer.from("old diagnostics 👋é"))
    diagnostics.push(Buffer.from([byte]));
  expect(diagnostics.text).toBe(" 👋é");
});

test("invalid, oversized and envelope-altering requests are rejected before worker dispatch", () => {
  const request = serializeWorkerRequest(
    "request",
    "status",
    { text: "🎙️" },
    1024,
  );
  const bytes = Buffer.byteLength(request) - 1;
  expect(
    serializeWorkerRequest("request", "status", { text: "🎙️" }, bytes),
  ).toBe(request);
  expect(() =>
    serializeWorkerRequest("request", "status", { text: "🎙️" }, bytes - 1),
  ).toThrow("UTF-8 bytes");
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(() =>
    serializeWorkerRequest("request", "status", circular, 1024),
  ).toThrow("cannot be serialized");
  expect(() =>
    serializeWorkerRequest(
      "request",
      "status",
      { toJSON: () => ({ id: "foreign" }) },
      1024,
    ),
  ).toThrow("request envelope");
});

test("worker schemas reject removed stream commands and malformed transcription results", () => {
  const identity = { protocolVersion: 1, id: "request" };
  expect(() =>
    validateWorkerRequest({ ...identity, command: "streamStart" }),
  ).toThrow("Unknown model worker command: streamStart");
  const result = {
    text: "Saved",
    language: "und",
    duration: 1,
    processingTime: 0.1,
  };
  expect(() => validateWorkerResult("transcribe", result)).not.toThrow();
  expect(() =>
    validateWorkerResult("transcribe", { ...result, text: null }),
  ).toThrow();
  expect(() =>
    validateWorkerResult("transcribe", { ...result, duration: NaN }),
  ).toThrow();
});

test("Redux CPU speech negotiation supports automatic language without weakening writing isolation", () => {
  expect(() =>
    validateWorkerRequest({
      protocolVersion: 1,
      id: "redux-load",
      command: "load",
      model: "redux",
      device: "cpu",
    }),
  ).not.toThrow();
  const capabilities = {
    schemaVersion: 1,
    engine: "speech",
    backend: "photon-cpu",
    modelFamily: "redux",
    timestamps: false,
    languageHints: { supported: false, languages: [] },
    vocabularyBiasing: false,
  };
  expect(() =>
    validateWorkerResult("capabilities", capabilities),
  ).not.toThrow();
  expect(() =>
    validateWorkerResult("capabilities", {
      ...capabilities,
      engine: "writing",
    }),
  ).toThrow();
});

test("speech engines are limited to R2T2 and Redux in requests and capability results", () => {
  const identity = { protocolVersion: 1, id: "request" };
  expect(() =>
    validateWorkerRequest({ ...identity, command: "load", model: "redux" }),
  ).not.toThrow();
  expect(() =>
    validateWorkerRequest({ ...identity, command: "load", model: "nemotron" }),
  ).toThrow("Invalid model worker speech model");
  expect(() =>
    validateWorkerRequest({
      ...identity,
      command: "capabilities",
      engine: "speech",
      model: "redux",
    }),
  ).not.toThrow();
  expect(() =>
    validateWorkerRequest({
      ...identity,
      command: "capabilities",
      engine: "speech",
      model: "nemotron",
    }),
  ).toThrow("Invalid model worker speech model");
  const capabilities = {
    schemaVersion: 1,
    engine: "speech",
    backend: "cuda-transformers",
    modelFamily: "r2t2",
    timestamps: false,
    languageHints: { supported: true, languages: ["en"] },
    vocabularyBiasing: false,
  };
  expect(() =>
    validateWorkerResult("capabilities", capabilities),
  ).not.toThrow();
  expect(() =>
    validateWorkerResult("capabilities", {
      ...capabilities,
      backend: "photon-cpu",
      modelFamily: "nemotron",
    }),
  ).toThrow("Invalid model worker capability backend/model family");
});

test("transcription hotwords must be a bounded string", () => {
  const identity = { protocolVersion: 1, id: "hints" };
  const transcribe = {
    ...identity,
    command: "transcribe",
    audioPath: "/tmp/a.wav",
    language: "auto",
    hotwords: "Kestrel, Moondream",
  };
  expect(validateWorkerRequest(transcribe)).toEqual(transcribe);
  expect(() =>
    validateWorkerRequest({ ...transcribe, hotwords: ["Kestrel"] }),
  ).toThrow();
  expect(() =>
    validateWorkerRequest({
      ...transcribe,
      hotwords: "x".repeat(MAX_RECOGNITION_HINT_CHARS + 1),
    }),
  ).toThrow("too long");
});
