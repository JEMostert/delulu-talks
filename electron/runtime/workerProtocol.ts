import type { DownloadBytes } from "../../src/types";
import { StringDecoder } from "node:string_decoder";

export const WORKER_PROTOCOL_VERSION = 1;
const PRESETS = new Set([
  "spoken-corrections",
  "polish",
  "concise",
  "structured",
  "prompt",
  "bullet-points",
  "professional-message",
]);
const MAGIC_MODELS = new Set(["qwen35Small", "qwen35Medium", "qwen35Large"]);
const SPEECH_MODELS = new Set(["r2t2", "nemotron"]);
const COMMANDS = new Set([
  "ping",
  "status",
  "load",
  "unload",
  "magicStatus",
  "magicLoad",
  "magicUnload",
  "magicRewrite",
  "transcribe",
  "shutdown",
  "capabilities",
  "streamStart",
  "streamAudio",
  "streamFinish",
]);
// Keep aligned with the shared PipelineTimings contract; unknown stages are omitted.
const TIMING_FIELDS = new Set([
  "captureEndMs",
  "preprocessingMs",
  "speechLoadMs",
  "speechRequestMs",
  "backendPreprocessingMs",
  "inferenceMs",
  "rewriteLoadMs",
  "rewritingMs",
  "clipboardMs",
  "pasteMs",
]);
type JsonObject = Record<string, unknown>;
export type WorkerResponse =
  | { protocolVersion: 1; id: string; ok: true; result: unknown }
  | { protocolVersion: 1; id: string; ok: false; error: string };
export type WorkerProgress = {
  protocolVersion: 1;
  type: "progress";
  id: string;
  command: string;
  stage: string;
  detail: string;
  fraction?: number;
  downloadBytes?: DownloadBytes;
};

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid model worker ${label}: expected an object`);
  return value as JsonObject;
}

function stringField(
  value: JsonObject,
  key: string,
  required = false,
  nonempty = false,
): void {
  if (!(key in value) && !required) return;
  if (typeof value[key] !== "string" || (nonempty && !value[key]))
    throw new Error(
      `Invalid model worker ${key}: expected ${nonempty ? "a nonempty" : "a"} string`,
    );
}

function numberField(value: JsonObject, key: string, required = false): void {
  if (!(key in value) && !required) return;
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field) || field < 0)
    throw new Error(
      `Invalid model worker ${key}: expected a finite nonnegative number`,
    );
}

function booleanField(value: JsonObject, key: string, required = false): void {
  if (!(key in value) && !required) return;
  if (typeof value[key] !== "boolean")
    throw new Error(`Invalid model worker ${key}: expected a boolean`);
}

function lifecycleFields(value: JsonObject): void {
  if (
    "residency" in value &&
    !["unloaded", "resident"].includes(value.residency as string)
  )
    throw new Error("Invalid model worker residency state");
  if (
    "warmup" in value &&
    !["unknown", "not-started", "warming", "complete"].includes(
      value.warmup as string,
    )
  )
    throw new Error("Invalid model worker warmup state");
  if (value.device !== null) stringField(value, "device");
  if (value.residency === "resident") stringField(value, "device", true, true);
  if (value.residency === "unloaded" && value.device != null)
    throw new Error("Unloaded model worker must not report an active device");
}

// Keep schema traversal bounded independently of the serialized byte budget.
function jsonValue(value: unknown, depth = 0): void {
  if (depth > 64)
    throw new Error("Model worker JSON exceeds 64 nesting levels");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) jsonValue(item, depth + 1);
    return;
  }
  throw new Error("Model worker payload must contain finite JSON values");
}

export function validateWorkerRequest(value: unknown): JsonObject {
  const request = object(value, "request");
  if (request.protocolVersion !== WORKER_PROTOCOL_VERSION)
    throw new Error(
      "Model worker protocol version mismatch. Restart the app or repair its runtime.",
    );
  stringField(request, "id", true, true);
  stringField(request, "command", true, true);
  if (
    Buffer.byteLength(request.id as string, "utf8") > 128 ||
    Buffer.byteLength(request.command as string, "utf8") > 64
  )
    throw new Error("Model worker request ID/command exceeds its byte limit");
  if (!COMMANDS.has(request.command as string))
    throw new Error(`Unknown model worker command: ${request.command}`);
  jsonValue(request);
  if (request.command === "load" || request.command === "magicLoad")
    stringField(request, "cacheDir");
  if (
    request.command === "load" &&
    request.device !== undefined &&
    !["auto", "cpu"].includes(request.device as string)
  )
    throw new Error("Unsupported speech device preference");
  if (request.command === "load" || request.command === "transcribe") {
    stringField(request, "model");
    if (
      request.model !== undefined &&
      !SPEECH_MODELS.has(request.model as string)
    )
      throw new Error("Invalid model worker speech model");
  }
  if (request.command === "streamStart") stringField(request, "language");
  if (request.command === "streamAudio") {
    stringField(request, "pcm", true);
    if ((request.pcm as string).length > 2_600_000)
      throw new Error("Live audio pieces are limited to five seconds");
    numberField(request, "sampleRate");
    if (
      request.sampleRate !== undefined &&
      (!Number.isSafeInteger(request.sampleRate) ||
        (request.sampleRate as number) < 8_000 ||
        (request.sampleRate as number) > 192_000)
    )
      throw new Error("Unsupported live sample rate");
  }
  if (request.command === "magicLoad") {
    stringField(request, "model");
    if (
      request.model !== undefined &&
      !MAGIC_MODELS.has(request.model as string)
    )
      throw new Error("Invalid model worker writing model");
  }
  if (request.command === "transcribe") {
    stringField(request, "audioPath", true, true);
    stringField(request, "language");
    numberField(request, "durationMs");
    for (const key of ["timestamps", "streaming", "vocabularyBiasing"]) {
      booleanField(request, key);
      if (request[key] === true)
        throw new Error(
          `Current R2T2 adapter does not support ${key}. Use buffered transcription with a language hint.`,
        );
    }
  }
  if (
    request.command === "capabilities" &&
    !["speech", "writing"].includes(request.engine as string)
  )
    throw new Error(
      "Model worker capability query requires speech or writing engine",
    );
  if (request.command === "magicRewrite") {
    stringField(request, "text", true);
    stringField(request, "preset");
    stringField(request, "instructions");
    booleanField(request, "allowInferences");
    if (
      (request.text as string).length > 500_000 ||
      ((request.instructions as string | undefined)?.length ?? 0) > 4_000
    )
      throw new Error("Model worker writing input exceeds its character limit");
    if (request.preset !== undefined && !PRESETS.has(request.preset as string))
      throw new Error("Invalid model worker rewrite preset");
  }
  return request;
}

export function validateWorkerResponse(value: unknown): WorkerResponse {
  const response = object(value, "response");
  if (response.protocolVersion !== WORKER_PROTOCOL_VERSION)
    throw new Error(
      "Model worker protocol version mismatch. Restart the app or repair its runtime.",
    );
  stringField(response, "id", true, true);
  if (Buffer.byteLength(response.id as string, "utf8") > 128)
    throw new Error("Invalid model worker response ID");
  booleanField(response, "ok", true);
  if (response.ok) {
    if (!("result" in response) || "error" in response)
      throw new Error("Invalid model worker success response");
    jsonValue(response.result);
  } else {
    stringField(response, "error", true, true);
    if (
      "result" in response ||
      Buffer.byteLength(response.error as string, "utf8") > 8_000
    )
      throw new Error("Invalid model worker failure response");
  }
  return response.ok
    ? {
        protocolVersion: 1,
        id: response.id as string,
        ok: true,
        result: response.result,
      }
    : {
        protocolVersion: 1,
        id: response.id as string,
        ok: false,
        error: response.error as string,
      };
}

export function validateWorkerProgress(value: unknown): WorkerProgress {
  const event = object(value, "progress event");
  if (
    event.protocolVersion !== WORKER_PROTOCOL_VERSION ||
    event.type !== "progress"
  )
    throw new Error(
      "Model worker progress protocol mismatch. Restart the app or repair its runtime.",
    );
  for (const key of ["id", "command", "stage"])
    stringField(event, key, true, true);
  stringField(event, "detail", true);
  for (const [key, limit] of [
    ["id", 128],
    ["command", 64],
    ["stage", 64],
    ["detail", 4_000],
  ] as const)
    if (Buffer.byteLength(event[key] as string, "utf8") > limit)
      throw new Error(
        `Model worker progress ${key} exceeds ${limit} UTF-8 bytes`,
      );
  numberField(event, "fraction");
  if (typeof event.fraction === "number" && event.fraction > 1)
    throw new Error(
      "Model worker progress fraction must be between zero and one",
    );
  const progress: WorkerProgress = {
    protocolVersion: 1,
    type: "progress",
    id: event.id as string,
    command: event.command as string,
    stage: event.stage as string,
    detail: event.detail as string,
  };
  if (typeof event.fraction === "number") progress.fraction = event.fraction;
  if (event.downloadBytes !== undefined) {
    const bytes = object(event.downloadBytes, "download bytes");
    if (
      typeof bytes.completed !== "number" ||
      !Number.isSafeInteger(bytes.completed) ||
      bytes.completed < 0 ||
      (bytes.total !== null &&
        (typeof bytes.total !== "number" ||
          !Number.isSafeInteger(bytes.total) ||
          bytes.total < bytes.completed)) ||
      (bytes.kind !== "transfer" && bytes.kind !== "reconstruction")
    )
      throw new Error(
        "Model worker download counters must be nonnegative safe integers with a nullable total and known byte kind",
      );
    progress.downloadBytes = {
      completed: bytes.completed,
      total: bytes.total as number | null,
      kind: bytes.kind,
    };
  }
  return progress;
}

export function validateWorkerResult(command: string, value: unknown): void {
  const resultObject = object(value, "result");
  if ("timings" in resultObject) {
    const timings = object(resultObject.timings, "timings");
    for (const key of Object.keys(timings)) {
      if (!TIMING_FIELDS.has(key))
        throw new Error(`Invalid model worker timing field: ${key}`);
      numberField(timings, key, true);
    }
  }
  const statusCommands = [
    "ping",
    "status",
    "load",
    "unload",
    "magicStatus",
    "magicLoad",
    "magicUnload",
  ];
  if (command === "capabilities") {
    const result = object(value, "capability result");
    if (
      result.schemaVersion !== 1 ||
      !["speech", "writing"].includes(result.engine as string)
    )
      throw new Error("Invalid model worker capability schema or engine");
    const speech = result.engine === "speech";
    if (
      !(speech ? ["r2t2", "nemotron"] : ["qwen3.5"]).includes(
        result.modelFamily as string,
      ) ||
      !(speech ? ["mlx", "cuda-transformers"] : ["transformers"]).includes(
        result.backend as string,
      )
    )
      throw new Error("Invalid model worker capability backend/model family");
    for (const key of ["timestamps", "streaming", "vocabularyBiasing"])
      booleanField(result, key, true);
    const hints = object(result.languageHints, "language hint capability");
    booleanField(hints, "supported", true);
    if (
      !Array.isArray(hints.languages) ||
      hints.languages.length > 128 ||
      hints.languages.some(
        (code) =>
          typeof code !== "string" ||
          !code ||
          Buffer.byteLength(code, "utf8") > 64,
      )
    )
      throw new Error("Invalid model worker language capability list");
    if (
      new Set(hints.languages).size !== hints.languages.length ||
      (!hints.supported && hints.languages.length)
    )
      throw new Error("Inconsistent model worker language capabilities");
  } else if (statusCommands.includes(command)) {
    const result = object(value, "status result");
    booleanField(result, "loaded", true);
    lifecycleFields(result);
    if (
      (result.residency === "resident" && !result.loaded) ||
      (result.residency === "unloaded" && result.loaded)
    )
      throw new Error("Model worker residency disagrees with loaded state");
    for (const key of ["model", "device"])
      if (result[key] !== null) stringField(result, key);
    if (command === "ping") stringField(result, "python", true, true);
  } else if (command === "transcribe") {
    const result = object(value, "transcription result");
    stringField(result, "text", true);
    stringField(result, "language", true);
    for (const key of ["duration", "processingTime"])
      numberField(result, key, true);
    numberField(result, "inferenceTime");
  } else if (command === "streamStart") {
    if (resultObject.started !== true)
      throw new Error("Model worker live session did not start");
    if (resultObject.latencyMs !== null) numberField(resultObject, "latencyMs");
  } else if (command === "streamAudio" || command === "streamFinish") {
    stringField(resultObject, "delta", true);
  } else if (command === "magicRewrite") {
    const result = object(value, "rewrite result");
    lifecycleFields(result);
    stringField(result, "text", true);
    stringField(result, "model", true);
    for (const key of [
      "processingTimeMs",
      "inputCharacters",
      "outputCharacters",
    ])
      numberField(result, key, true);
    for (const key of ["inputCharacters", "outputCharacters"]) {
      const count = result[key];
      if (typeof count !== "number" || !Number.isSafeInteger(count))
        throw new Error(`Invalid model worker ${key}: expected a safe integer`);
    }
    booleanField(result, "includedInferences", true);
  } else if (command === "shutdown") {
    if (object(value, "shutdown result").shutdown !== true)
      throw new Error("Invalid model worker shutdown result");
  }
}

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
    serialized = JSON.stringify(
      { ...payload, protocolVersion: WORKER_PROTOCOL_VERSION, id, command },
      (_key, value) => {
        if (typeof value === "number" && !Number.isFinite(value))
          throw new Error("Non-finite number");
        if (["bigint", "function", "symbol"].includes(typeof value))
          throw new Error(`Unsupported ${typeof value} value`);
        return value;
      },
    );
    const envelope = serialized && JSON.parse(serialized);
    if (
      !envelope ||
      envelope.id !== id ||
      envelope.command !== command ||
      envelope.protocolVersion !== WORKER_PROTOCOL_VERSION
    )
      throw new Error(
        "Payload serialization must preserve the request envelope",
      );
    validateWorkerRequest(envelope);
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
