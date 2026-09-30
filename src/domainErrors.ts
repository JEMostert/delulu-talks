export const DOMAIN_ERROR_POLICIES = {
  INVALID_REQUEST: "never",
  UNTRUSTED_SENDER: "never",
  BUSY: "after-idle",
  CANCELLED: "never",
  TIMEOUT: "reload-runtime",
  RUNTIME_SETUP_TIMEOUT: "repair-runtime",
  RUNTIME_SETUP_FAILED: "repair-runtime",
  OPERATION_INTERRUPTED: "reload-runtime",
  WORKER_UNAVAILABLE: "repair-runtime",
  WORKER_EXITED: "reload-runtime",
  WORKER_PROTOCOL: "repair-runtime",
  BACKEND_FAILURE: "manual",
  OPERATION_FAILED: "manual",
} as const;

export type DomainErrorCode = keyof typeof DOMAIN_ERROR_POLICIES;
export type RetryPolicy = (typeof DOMAIN_ERROR_POLICIES)[DomainErrorCode];
export type DomainFailure = {
  schemaVersion: 1;
  code: DomainErrorCode;
  operationId: string;
  operation: string;
  message: string;
  retry: RetryPolicy;
  cancelled: boolean;
  cancellationEffect: "none" | "worker-stopped";
  // Backend messages/stacks can contain transcript text or local paths. Keep
  // the actual cause on the owning Error; serialize only its safe category.
  cause?: { name: string; code?: string };
};

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly operationId: string;
  readonly operation: string;
  readonly retry: RetryPolicy;
  readonly cancelled: boolean;
  readonly cancellationEffect: DomainFailure["cancellationEffect"];
  readonly cause: unknown;
  constructor(
    code: DomainErrorCode,
    message: string,
    context: { operationId: string; operation: string; cause?: unknown; cancellationEffect?: DomainFailure["cancellationEffect"] },
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.operationId = context.operationId;
    this.operation = context.operation;
    this.retry = DOMAIN_ERROR_POLICIES[code];
    this.cancelled = code === "CANCELLED";
    this.cancellationEffect = context.cancellationEffect ?? "none";
    this.cause = context.cause;
  }
}

export function domainError(
  reason: unknown,
  context: { operationId: string; operation: string; code?: DomainErrorCode; message?: string },
): DomainError {
  if (reason instanceof DomainError) return reason;
  return new DomainError(
    context.code ?? "OPERATION_FAILED",
    context.message ?? (reason instanceof Error ? reason.message : "Operation failed"),
    { ...context, cause: reason },
  );
}

export function serializeDomainError(error: DomainError): DomainFailure {
  const cause = error.cause;
  const category = cause instanceof Error
    ? { name: /^[A-Za-z][A-Za-z0-9]*Error$/.test(cause.name) ? cause.name : "Error" }
    : undefined;
  const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
  return {
    schemaVersion: 1,
    code: error.code,
    operationId: error.operationId,
    operation: error.operation,
    message: error.message.slice(0, 2000),
    retry: error.retry,
    cancelled: error.cancelled,
    cancellationEffect: error.cancellationEffect,
    ...(category ? { cause: {
      ...category,
      ...(typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? { code } : {}),
    } } : {}),
  };
}

export type OperationResult<T> =
  | { transport: "delulu-operation-v1"; ok: true; value: T }
  | { transport: "delulu-operation-v1"; ok: false; error: DomainFailure };

const ERROR_MARKER = "\n@delulu-domain-error:";

/** Error properties are stripped by Electron's contextBridge. The renderer
 * restores the safe contract from this message transport at its API boundary. */
export function encodeDomainFailure(failure: DomainFailure): Error {
  return new Error(`${failure.message}${ERROR_MARKER}${JSON.stringify(failure)}`);
}

export function restoreDomainError(reason: unknown): unknown {
  if (!(reason instanceof Error)) return reason;
  const index = reason.message.lastIndexOf(ERROR_MARKER);
  if (index < 0) return reason;
  try {
    const failure = JSON.parse(reason.message.slice(index + ERROR_MARKER.length)) as DomainFailure;
    if (failure.schemaVersion !== 1 || !Object.prototype.hasOwnProperty.call(DOMAIN_ERROR_POLICIES, failure.code) ||
        typeof failure.operationId !== "string" || typeof failure.operation !== "string" ||
        typeof failure.message !== "string") return reason;
    return new DomainError(failure.code, failure.message, {
      operationId: failure.operationId, operation: failure.operation,
      cancellationEffect: failure.cancellationEffect === "worker-stopped" ? "worker-stopped" : "none",
      cause: failure.cause,
    });
  } catch {
    return reason;
  }
}
