import { expect, test } from "bun:test";
import type { InsertResult } from "./ipc";
test("failed delivery retains a reason for recovery", () => {
  const result: InsertResult = {
    kind: "failed",
    reason: "Clipboard unavailable",
  };
  expect(result.reason).toBe("Clipboard unavailable");
});
