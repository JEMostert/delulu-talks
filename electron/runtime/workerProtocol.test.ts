import { expect, test } from "bun:test";
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
    "ping",
    { text: "🎙️" },
    1024,
  );
  const bytes = Buffer.byteLength(request) - 1;
  expect(serializeWorkerRequest("request", "ping", { text: "🎙️" }, bytes)).toBe(
    request,
  );
  expect(() =>
    serializeWorkerRequest("request", "ping", { text: "🎙️" }, bytes - 1),
  ).toThrow("UTF-8 bytes");
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(() =>
    serializeWorkerRequest("request", "ping", circular, 1024),
  ).toThrow("cannot be serialized");
  expect(() =>
    serializeWorkerRequest(
      "request",
      "ping",
      { toJSON: () => ({ id: "foreign" }) },
      1024,
    ),
  ).toThrow("request envelope");
});

test("worker schemas reject legacy streaming flags and malformed transcription results", () => {
  const identity = { protocolVersion: 1, id: "request" };
  expect(() =>
    validateWorkerRequest({
      ...identity,
      command: "transcribe",
      audioPath: "/audio.wav",
      streaming: true,
    }),
  ).toThrow("does not support");
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
