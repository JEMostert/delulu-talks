import { expect, test } from "bun:test";
import {
  BoundedWorkerLines,
  DEFAULT_WORKER_PROTOCOL_LIMITS,
  WorkerDiagnosticTail,
  serializeWorkerRequest,
  workerProtocolLimits,
} from "./workerProtocol";

test("default transport limits are explicit byte and request budgets", () => {
  expect(DEFAULT_WORKER_PROTOCOL_LIMITS).toEqual({
    requestBytes: 4 * 1024 * 1024,
    stdoutLineBytes: 8 * 1024 * 1024,
    pendingRequests: 8,
    stderrBytes: 80_000,
  });
});

test.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "protocol limit %s is rejected before use",
  (value) => {
    for (const key of Object.keys(DEFAULT_WORKER_PROTOCOL_LIMITS))
      expect(() => workerProtocolLimits({ [key]: value })).toThrow(
        "positive integer",
      );
  },
);

test("serialization counts exact UTF-8 wire bytes, excluding the delimiter", () => {
  const id = "fixture";
  const payload = { text: "👋" };
  const bytes = Buffer.byteLength(
    JSON.stringify({ ...payload, protocolVersion: 1, id, command: "ping" }),
  );
  expect(serializeWorkerRequest(id, "ping", payload, bytes)).toBe(
    `${JSON.stringify({ ...payload, protocolVersion: 1, id, command: "ping" })}\n`,
  );
  expect(() => serializeWorkerRequest(id, "ping", payload, bytes - 1)).toThrow(
    "UTF-8 bytes",
  );
});

test("framing handles every UTF-8 split, CRLF, multiple lines and EOF", () => {
  const bytes = Buffer.from("👋é\r\nsecond\rlast 👋");
  for (let split = 0; split <= bytes.length; split++) {
    const parser = new BoundedWorkerLines(100);
    const lines: string[] = [];
    const receive = (line: string) => {
      lines.push(line);
      return true;
    };
    parser.push(bytes.subarray(0, split), receive);
    parser.push(bytes.subarray(split), receive);
    parser.end(receive);
    expect(lines).toEqual(["👋é", "second", "last 👋"]);
  }
});

test("maximum-sized CRLF lines accept split delimiters and reject excess content", () => {
  const parser = new BoundedWorkerLines(4);
  const lines: string[] = [];
  const receive = (line: string) => {
    lines.push(line);
    return true;
  };
  parser.push(Buffer.from("👋\r"), receive);
  parser.push(Buffer.from("\nnext\n"), receive);
  expect(lines).toEqual(["👋", "next"]);
  expect(() => parser.push(Buffer.from("👋x"), receive)).toThrow("exceeds 4");
});

test("unterminated log lines cannot accumulate beyond their byte budget", () => {
  const parser = new BoundedWorkerLines(8);
  parser.push(Buffer.from("12345678"), () => true);
  expect(() => parser.push(Buffer.from("9"), () => true)).toThrow("exceeds 8");
});

test("diagnostic tails stay byte bounded and preserve split Unicode without replacement", () => {
  const tail = new WorkerDiagnosticTail(7);
  const bytes = Buffer.from("old 👋é suffix 👋é");
  for (const byte of bytes) {
    tail.push(Buffer.from([byte]));
    expect(Buffer.byteLength(tail.text)).toBeLessThanOrEqual(7);
    expect(tail.text).not.toContain("�");
  }
  expect(tail.text).toBe(" 👋é");
});

test("invalid diagnostic bytes cannot expand past the retained UTF-8 budget", () => {
  const tail = new WorkerDiagnosticTail(7);
  tail.push(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
  expect(Buffer.byteLength(tail.text)).toBeLessThanOrEqual(7);
});
