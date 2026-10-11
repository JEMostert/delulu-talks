import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerClient } from "./workerClient";

test.skipIf(process.platform === "win32")(
  "stopAndWait does not wait out its fallback when the worker already exited",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-client-"));
    const script = join(dir, "worker.sh");
    // The background sleep inherits stdout, so 'close' waits for it while 'exit' fires at once.
    writeFileSync(script, "sleep 30 &\nexit 0\n");
    const client = new WorkerClient(
      () => ({ python: "/bin/sh", script, env: process.env }),
      () => undefined,
    );
    const pending = client.request("status", {}, 20_000).catch(() => undefined);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const started = Date.now();
      await client.stopAndWait();
      expect(Date.now() - started).toBeLessThan(2_000);
      await pending;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  15_000,
);
