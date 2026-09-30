import { expect, test } from "bun:test";
import {
  DomainError,
  domainError,
  encodeDomainFailure,
  restoreDomainError,
  serializeDomainError,
} from "./domainErrors";

test("backend causes stay available locally without crossing the renderer boundary", () => {
  const cause = new Error("private transcript /home/owner/recording.wav");
  const error = new DomainError("BACKEND_FAILURE", "Model operation failed", {
    operationId: "operation-1",
    operation: "transcribe",
    cause,
  });
  expect(error.cause).toBe(cause);
  const failure = serializeDomainError(error);
  expect(failure.cause).toEqual({ name: "Error" });
  expect(JSON.stringify(failure)).not.toContain("private transcript");
  expect(JSON.stringify(failure)).not.toContain("/home/owner");
  const restored = restoreDomainError(
    new Error(encodeDomainFailure(failure).message),
  );
  expect(restored).toBeInstanceOf(DomainError);
  expect(restored).toMatchObject({
    code: "BACKEND_FAILURE",
    operationId: "operation-1",
    retry: "manual",
    cancelled: false,
  });
  expect((restored as Error).message).toBe("Model operation failed");
});

test("retry and cancellation policy is derived from the code after transport", () => {
  const error = new DomainError("CANCELLED", "Cancelled", {
    operationId: "operation-2",
    operation: "load",
    cancellationEffect: "worker-stopped",
  });
  const failure = {
    ...serializeDomainError(error),
    retry: "manual" as const,
    cancelled: false,
  };
  expect(restoreDomainError(encodeDomainFailure(failure))).toMatchObject({
    retry: "never",
    cancelled: true,
    cancellationEffect: "worker-stopped",
  });
  expect(domainError(error, { operationId: "outer", operation: "ipc" })).toBe(
    error,
  );
});

test("ordinary and malformed transport errors remain ordinary errors", () => {
  const ordinary = new Error("Ordinary error");
  const malformed = new Error(
    'Failure\n@delulu-domain-error:{"schemaVersion":1,"code":"__proto__"}',
  );
  expect(restoreDomainError(ordinary)).toBe(ordinary);
  expect(restoreDomainError(malformed)).toBe(malformed);
});
