import { StringDecoder } from "node:string_decoder";

export type WorkerProtocolLimits = {
  requestBytes: number;
  stdoutLineBytes: number;
  pendingRequests: number;
  stderrBytes: number;
};

/** UTF-8 wire bytes exclude the newline delimiter; stdout includes log lines. */
export const DEFAULT_WORKER_PROTOCOL_LIMITS: Readonly<WorkerProtocolLimits> =
  Object.freeze({
    requestBytes: 4 * 1024 * 1024,
    stdoutLineBytes: 8 * 1024 * 1024,
    pendingRequests: 8,
    stderrBytes: 80_000,
  });

export function workerProtocolLimits(
  overrides: Partial<WorkerProtocolLimits> = {},
): WorkerProtocolLimits {
  const limits = { ...DEFAULT_WORKER_PROTOCOL_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(
        `Worker protocol limit ${name} must be a positive integer`,
      );
  }
  return limits;
}

/** Grow one bounded buffer instead of retaining arbitrarily many tiny chunks. */
export class BoundedWorkerLines {
  private buffer = Buffer.alloc(0);
  private length = 0;
  private afterCR = false;
  constructor(private readonly maxBytes: number) {}

  private append(chunk: Buffer): void {
    const length = this.length + chunk.length;
    if (length > this.maxBytes)
      throw new Error(
        `Model worker stdout line exceeds ${this.maxBytes} UTF-8 bytes. Load the model to retry.`,
      );
    if (length > this.buffer.length) {
      const next = Buffer.allocUnsafe(
        Math.min(this.maxBytes, Math.max(length, this.buffer.length * 2, 1024)),
      );
      this.buffer.copy(next, 0, 0, this.length);
      this.buffer = next;
    }
    chunk.copy(this.buffer, this.length);
    this.length = length;
  }

  private take(): string {
    const line = this.buffer.toString("utf8", 0, this.length);
    this.length = 0;
    return line;
  }

  push(chunk: Buffer, onLine: (line: string) => boolean): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.afterCR) {
        this.afterCR = false;
        if (chunk[offset] === 10) {
          offset++;
          continue;
        }
      }
      const lf = chunk.indexOf(10, offset);
      const cr = chunk.indexOf(13, offset);
      const newline = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
      if (newline < 0) {
        this.append(chunk.subarray(offset));
        return;
      }
      this.append(chunk.subarray(offset, newline));
      this.afterCR = chunk[newline] === 13;
      if (!onLine(this.take())) return;
      offset = newline + 1;
    }
  }

  end(onLine: (line: string) => boolean): void {
    if (this.length) onLine(this.take());
  }
}

/** Keep raw bytes across chunks so cutting the tail cannot split UTF-8 text. */
export class WorkerDiagnosticTail {
  private buffer = Buffer.alloc(0);
  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    if (chunk.length >= this.maxBytes) {
      this.buffer = Buffer.from(chunk.subarray(chunk.length - this.maxBytes));
    } else {
      const retained = Math.min(
        this.buffer.length,
        this.maxBytes - chunk.length,
      );
      this.buffer = Buffer.concat([
        this.buffer.subarray(this.buffer.length - retained),
        chunk,
      ]);
    }
  }

  get text(): string {
    let start = 0;
    while (start < this.buffer.length && (this.buffer[start] & 0xc0) === 0x80)
      start++;
    const text = new StringDecoder("utf8").write(this.buffer.subarray(start));
    // Invalid input can expand into replacement characters; keep that bounded too.
    const encoded = Buffer.from(text, "utf8");
    if (encoded.length <= this.maxBytes) return text;
    start = encoded.length - this.maxBytes;
    while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start++;
    return new StringDecoder("utf8").write(encoded.subarray(start));
  }
}

export function serializeWorkerRequest(
  id: string,
  command: string,
  payload: Record<string, unknown>,
  maxBytes: number,
): string {
  if (typeof command !== "string" || !command)
    throw new Error("Model worker command must be a nonempty string");
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("Model worker payload must be a JSON object");
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify({ ...payload, id, command }, (_key, value) => {
      if (["bigint", "function", "symbol"].includes(typeof value))
        throw new Error(`Unsupported ${typeof value} value`);
      return value;
    });
    const envelope = serialized && JSON.parse(serialized);
    if (!envelope || envelope.id !== id || envelope.command !== command)
      throw new Error(
        "Payload serialization must preserve the request envelope",
      );
  } catch (reason) {
    throw new Error(
      `Model worker request cannot be serialized as JSON: ${reason instanceof Error ? reason.message : String(reason)}. Correct the request and try again.`,
    );
  }
  const bytes = Buffer.byteLength(serialized!, "utf8");
  if (bytes > maxBytes)
    throw new Error(
      `Model worker request exceeds ${maxBytes} UTF-8 bytes (${bytes} bytes). Use a smaller text selection and try again.`,
    );
  return `${serialized}\n`;
}
