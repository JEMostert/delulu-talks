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

test("CPU speech negotiation for Small and Medium does not weaken writing isolation", () => {
  for (const [model, family, languages] of [
    ["canary-180m", "canary", ["en", "de", "fr", "es"]],
    ["parakeet-v2", "parakeet", ["en"]],
    ["parakeet-v3", "parakeet", []],
  ] as const) {
    expect(() =>
      validateWorkerRequest({
        protocolVersion: 1,
        id: `${model}-load`,
        command: "load",
        model,
        language: "en",
        device: "cpu",
      }),
    ).not.toThrow();
    const capabilities = {
      schemaVersion: 1,
      engine: "speech",
      backend: "onnx-cpu",
      modelFamily: family,
      timestamps: false,
      languageHints: { supported: languages.length > 0, languages },
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
  }
});

test("speech engines are limited to the three sizes in requests and capability results", () => {
  const identity = { protocolVersion: 1, id: "request" };
  expect(() =>
    validateWorkerRequest({
      ...identity,
      command: "load",
      model: "canary-180m",
    }),
  ).not.toThrow();
  for (const model of ["nemotron", "redux"])
    expect(() =>
      validateWorkerRequest({ ...identity, command: "load", model }),
    ).toThrow("Invalid model worker speech model");
  expect(() =>
    validateWorkerRequest({
      ...identity,
      command: "capabilities",
      engine: "speech",
      model: "parakeet-v3",
    }),
  ).not.toThrow();
  expect(() =>
    validateWorkerRequest({
      ...identity,
      command: "capabilities",
      engine: "speech",
      model: "redux",
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
