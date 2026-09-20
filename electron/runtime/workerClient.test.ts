import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkerClient,
  operationTimeout,
  transcriptionTimeout,
} from "./workerClient";

test("interactive operations do not inherit download deadlines", () => {
  expect(operationTimeout("transcribe")).toBe(120_000);
  expect(operationTimeout("magicRewrite")).toBe(180_000);
  expect(operationTimeout("load")).toBe(30 * 60_000);
  expect(operationTimeout("ping")).toBe(30_000);
  expect(transcriptionTimeout(5000)).toBe(120_000);
  expect(transcriptionTimeout(100_000)).toBe(300_000);
  expect(transcriptionTimeout(Infinity)).toBe(900_000);
  expect(transcriptionTimeout(undefined)).toBe(900_000);
  expect(transcriptionTimeout(1_000_000)).toBe(900_000);
});

function harness(script: string) {
  const dir = mkdtempSync(join(tmpdir(), "delulu-worker-"));
  const path = join(dir, "worker.py");
  writeFileSync(path, script);
  const failures: Error[] = [];
  const client = new WorkerClient(
    () => ({ python: "python3", script: path, env: process.env }),
    (error) => failures.push(error),
  );
  return {
    client,
    failures,
    cleanup: () => {
      client.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("independent speech/writing clients survive repeated stop and restart cycles", async () => {
  const script = `import sys,json\nfor line in sys.stdin:\n r=json.loads(line)\n print('@delulu:'+json.dumps({'id':r['id'],'ok':True,'result':r['command']}),flush=True)\n`;
  const speech = harness(script);
  const writing = harness(script);
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      expect(await speech.client.request<string>("transcribe")).toBe(
        "transcribe",
      );
      await speech.client.stopAndWait();
      expect(speech.client.running).toBe(false);
      expect(await writing.client.request<string>("rewrite")).toBe("rewrite");
      await writing.client.stopAndWait();
      expect(writing.client.running).toBe(false);
    }
    expect(speech.failures).toHaveLength(0);
    expect(writing.failures).toHaveLength(0);
  } finally {
    speech.cleanup();
    writing.cleanup();
  }
});

test("worker separates logging from protocol responses", async () => {
  const h = harness(
    `import sys,json\nfor line in sys.stdin:\n r=json.loads(line)\n print('ordinary log',flush=True)\n print('@delulu:'+json.dumps({'id':r['id'],'ok':True,'result':r['command']}),flush=True)\n`,
  );
  try {
    expect(await h.client.request<string>("ping")).toBe("ping");
    expect(h.client.busy).toBe(false);
    expect(h.failures).toHaveLength(0);
  } finally {
    h.cleanup();
  }
});

test("timeout terminates the stalled worker and rejects every queued request", async () => {
  const h = harness("import time\ntime.sleep(60)\n");
  try {
    const results = await Promise.allSettled([
      h.client.request("slow", {}, 80),
      h.client.request("queued", {}, 3000),
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(h.client.running).toBe(false);
    expect(h.client.busy).toBe(false);
    expect(h.failures).toHaveLength(1);
  } finally {
    h.cleanup();
  }
});

test("spawn failures reject immediately rather than waiting for timeout", async () => {
  const client = new WorkerClient(
    () => ({ python: "/does/not/exist/python", script: "worker.py", env: {} }),
    () => undefined,
  );
  try {
    await expect(client.request("ping", {}, 3000)).rejects.toThrow();
    expect(client.busy).toBe(false);
  } finally {
    client.stop();
  }
});

test.skipIf(process.platform === "win32")(
  "stop terminates runtime descendants",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "delulu-descendant-"));
    const stopped = join(dir, "stopped");
    const descendant = `import signal,time,pathlib\ndef stop(*args):\n pathlib.Path(${JSON.stringify(stopped)}).touch()\n raise SystemExit(0)\nsignal.signal(signal.SIGTERM,stop)\nprint('ready',flush=True)\ntime.sleep(60)\n`;
    const h = harness(
      `import subprocess,sys,json\np=subprocess.Popen([sys.executable,'-u','-c',${JSON.stringify(descendant)}],stdout=subprocess.PIPE,text=True)\np.stdout.readline()\nfor line in sys.stdin:\n r=json.loads(line)\n print('@delulu:'+json.dumps({'id':r['id'],'ok':True,'result':p.pid}),flush=True)\n`,
    );
    try {
      await h.client.request("ping", {}, 3000);
      h.client.stop();
      for (let attempt = 0; attempt < 100 && !existsSync(stopped); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(existsSync(stopped)).toBe(true);
    } finally {
      h.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
