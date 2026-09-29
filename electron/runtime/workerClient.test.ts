import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WorkerClient,
  operationTimeout,
  transcriptionTimeout,
} from "./workerClient";
import {
  DEFAULT_WORKER_PROTOCOL_LIMITS,
  type WorkerProtocolLimits,
} from "./workerProtocol";

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

// Real subprocess transport, synthetic protocol only: no model downloads or inference.
function harness(
  script: string,
  options: {
    onFailure?: (error: Error) => void;
    onProgress?: (detail: string) => void;
    limits?: Partial<WorkerProtocolLimits>;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "delulu-worker-"));
  const path = join(dir, "worker.py");
  writeFileSync(path, script);
  const failures: Error[] = [];
  let starts = 0;
  const client = new WorkerClient(
    () => {
      starts++;
      return { python: "python3", script: path, env: process.env };
    },
    (error) => {
      failures.push(error);
      options.onFailure?.(error);
    },
    options.onProgress,
    options.limits,
  );
  return {
    client,
    failures,
    get starts() {
      return starts;
    },
    cleanup: () => {
      client.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test.each([
  "not-json",
  "null",
  "[]",
  '{"id":4,"ok":true}',
  '{"id":"x","ok":"yes"}',
])(
  "malformed worker response %s rejects all pending requests once",
  async (response) => {
    const h = harness(`import sys
sys.stdin.readline()
sys.stdout.write(${JSON.stringify(`@delulu:${response}\n@delulu:${response}\n`)})
sys.stdout.flush()
`);
    try {
      const results = await Promise.allSettled([
        h.client.request("first", {}, 3000),
        h.client.request("second", {}, 3000),
      ]);
      expect(results.map((result) => result.status)).toEqual([
        "rejected",
        "rejected",
      ]);
      expect(h.client.running).toBe(false);
      expect(h.client.busy).toBe(false);
      expect(h.failures).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  },
);

test("responses complete by ID even when the worker finishes in reverse order", async () => {
  const h = harness(`import sys,json
requests = [json.loads(sys.stdin.readline()) for _ in range(2)]
for request in reversed(requests):
 print('@delulu:'+json.dumps({'id':request['id'],'ok':True,'result':request['command']}),flush=True)
`);
  try {
    expect(
      await Promise.all([
        h.client.request<string>("first", {}, 3000),
        h.client.request<string>("second", {}, 3000),
      ]),
    ).toEqual(["first", "second"]);
    expect(h.client.busy).toBe(false);
    expect(h.failures).toHaveLength(0);
  } finally {
    h.cleanup();
  }
});

test("duplicate and unknown response IDs cannot complete a different request", async () => {
  const h = harness(`import sys,json
first,second = [json.loads(sys.stdin.readline()) for _ in range(2)]
for response in [
 {'id':first['id'],'ok':True,'result':'first'},
 {'id':first['id'],'ok':True,'result':'duplicate'},
 {'id':'unknown','ok':True,'result':'unrelated'},
 {'id':second['id'],'ok':True,'result':'second'},
]:
 print('@delulu:'+json.dumps(response),flush=True)
`);
  try {
    expect(
      await Promise.all([
        h.client.request<string>("first", {}, 3000),
        h.client.request<string>("second", {}, 3000),
      ]),
    ).toEqual(["first", "second"]);
    expect(h.client.busy).toBe(false);
    expect(h.failures).toHaveLength(0);
  } finally {
    h.cleanup();
  }
});

test("an operation error rejects its request while another request still succeeds", async () => {
  const h = harness(`import sys,json
for line in sys.stdin:
 request = json.loads(line)
 if request['command'] == 'broken':
  response = {'id':request['id'],'ok':False,'error':'Fixture operation failed'}
 else:
  response = {'id':request['id'],'ok':True,'result':'healthy'}
 print('@delulu:'+json.dumps(response),flush=True)
`);
  try {
    const [broken, healthy] = await Promise.allSettled([
      h.client.request("broken", {}, 3000),
      h.client.request<string>("ping", {}, 3000),
    ]);
    expect(broken.status).toBe("rejected");
    if (broken.status === "rejected")
      expect(broken.reason.message).toBe("Fixture operation failed");
    expect(healthy).toEqual({ status: "fulfilled", value: "healthy" });
    expect(h.client.running).toBe(true);
    expect(h.client.busy).toBe(false);
    expect(h.failures).toHaveLength(0);
  } finally {
    h.cleanup();
  }
});

test.each([0, 7])(
  "worker exit %i rejects every pending request",
  async (code) => {
    const h = harness(`import sys
sys.stdin.readline()
raise SystemExit(${code})
`);
    try {
      const results = await Promise.allSettled([
        h.client.request("first", {}, 3000),
        h.client.request("second", {}, 3000),
      ]);
      for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected")
          expect(result.reason.message).toBe(
            code === 0
              ? "Model worker closed"
              : `Model worker exited (${code})`,
          );
      }
      expect(h.client.running).toBe(false);
      expect(h.client.busy).toBe(false);
      expect(h.failures).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  },
);

test("buffered output from a failed worker cannot fail or report progress for a retry", async () => {
  const retry: { promise?: Promise<string> } = {};
  const progress: string[] = [];
  const h = harness(
    `import sys,json
for line in sys.stdin:
 request = json.loads(line)
 if request['command'] == 'broken':
  sys.stdout.write('@delulu:not-json\\n@delulu:{}\\n@delulu-progress:obsolete progress\\n')
  sys.stdout.flush()
 else:
  print('@delulu:'+json.dumps({'id':request['id'],'ok':True,'result':'recovered'}),flush=True)
`,
    {
      onFailure: () => {
        if (!retry.promise) {
          retry.promise = h.client.request<string>("ping", {}, 3000);
          void retry.promise.catch(() => undefined);
        }
      },
      onProgress: (detail) => progress.push(detail),
    },
  );
  try {
    await expect(h.client.request("broken", {}, 3000)).rejects.toThrow();
    expect(retry.promise).toBeDefined();
    expect(await retry.promise).toBe("recovered");
    expect(progress).toEqual([]);
    expect(h.failures).toHaveLength(1);
    expect(h.client.running).toBe(true);
    expect(h.client.busy).toBe(false);
  } finally {
    h.cleanup();
  }
});

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
  const h = harness(`import sys,json,time
for line in sys.stdin:
 request = json.loads(line)
 if request['command'] == 'slow':
  time.sleep(60)
 else:
  print('@delulu:'+json.dumps({'id':request['id'],'ok':True,'result':'recovered'}),flush=True)
`);
  try {
    const results = await Promise.allSettled([
      h.client.request("slow", {}, 80),
      h.client.request("queued", {}, 3000),
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(h.client.running).toBe(false);
    expect(h.client.busy).toBe(false);
    expect(h.failures).toHaveLength(1);
    expect(await h.client.request<string>("ping", {}, 3000)).toBe("recovered");
    expect(h.client.running).toBe(true);
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
      await h.client.request<string>("ping", {}, 3000);
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

test("download progress does not consume the pending model response", async () => {
  const dir = mkdtempSync(join(tmpdir(), "delulu-progress-"));
  const path = join(dir, "worker.py");
  writeFileSync(
    path,
    `import sys,json\nfor line in sys.stdin:\n r=json.loads(line)\n print('@delulu-progress:Downloading weights 50%',flush=True)\n print('@delulu:'+json.dumps({'id':r['id'],'ok':True,'result':{'loaded':True}}),flush=True)\n`,
  );
  const progress: string[] = [];
  const failures: Error[] = [];
  const client = new WorkerClient(
    () => ({ python: "python3", script: path, env: process.env }),
    (e) => failures.push(e),
    (d) => progress.push(d),
  );
  try {
    expect(await client.request<{ loaded: boolean }>("load")).toEqual({
      loaded: true,
    });
    expect(progress).toEqual(["Downloading weights 50%"]);
    expect(failures).toHaveLength(0);
  } finally {
    await client.stopAndWait();
    rmSync(dir, { recursive: true, force: true });
  }
});

const echoWorker = `import sys,json
for line in sys.stdin:
 request = json.loads(line)
 print('@delulu:'+json.dumps({'id':request['id'],'ok':True,'result':request.get('text',request['command'])}),flush=True)
`;

test("exact UTF-8 request budget succeeds and excess requests reject before spawn", async () => {
  const payload = { text: "👋" };
  const bytes = Buffer.byteLength(
    JSON.stringify({ ...payload, id: "0".repeat(36), command: "ping" }),
  );
  const h = harness(echoWorker, { limits: { requestBytes: bytes } });
  try {
    await expect(
      h.client.request<string>("ping", { text: "👋x" }),
    ).rejects.toThrow("UTF-8 bytes");
    expect(h.starts).toBe(0);
    expect(h.client.running).toBe(false);
    expect(h.client.busy).toBe(false);
    expect(await h.client.request<string>("ping", payload)).toBe("👋");
    expect(h.starts).toBe(1);
    expect(h.failures).toHaveLength(0);
  } finally {
    h.cleanup();
  }
});

test("unserializable requests cannot spawn a worker or strand pending work", async () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const h = harness(echoWorker);
  try {
    for (const payload of [
      cycle,
      { value: 1n },
      { value: () => "unsent" },
      { value: Symbol("unsent") },
      { toJSON: () => undefined },
    ]) {
      await expect(h.client.request<string>("ping", payload)).rejects.toThrow(
        "serialized as JSON",
      );
      expect(h.starts).toBe(0);
      expect(h.client.busy).toBe(false);
    }
    expect(await h.client.request<string>("ping")).toBe("ping");
    expect(h.starts).toBe(1);
    expect(h.failures).toHaveLength(0);
  } finally {
    h.cleanup();
  }
});

test("rejected input leaves an existing request and its generation healthy", async () => {
  const h = harness(
    `import sys,json,time
for line in sys.stdin:
 request = json.loads(line)
 time.sleep(0.05)
 print('@delulu:'+json.dumps({'id':request['id'],'ok':True,'result':request['command']}),flush=True)
`,
    { limits: { requestBytes: 128 } },
  );
  try {
    const pending = h.client.request("first", {}, 3000);
    await expect(
      h.client.request("large", { text: "👋".repeat(100) }),
    ).rejects.toThrow("UTF-8 bytes");
    expect(h.client.running).toBe(true);
    expect(h.client.busy).toBe(true);
    expect(await pending).toBe("first");
    expect(await h.client.request<string>("next")).toBe("next");
    expect(h.starts).toBe(1);
    expect(h.failures).toHaveLength(0);
  } finally {
    h.cleanup();
  }
});

test("pending request cap rejects only excess work and releases slots on completion", async () => {
  const h = harness(
    `import sys,json,time
for line in sys.stdin:
 request = json.loads(line)
 time.sleep(0.05)
 print('@delulu:'+json.dumps({'id':request['id'],'ok':True,'result':request['command']}),flush=True)
`,
    { limits: { pendingRequests: 2 } },
  );
  try {
    const first = h.client.request("first", {}, 3000);
    const second = h.client.request("second", {}, 3000);
    await expect(h.client.request("excess", {}, 3000)).rejects.toThrow(
      "2 pending requests",
    );
    expect(await first).toBe("first");
    const third = h.client.request("after-slot-release", {}, 3000);
    expect(await Promise.all([second, third])).toEqual([
      "second",
      "after-slot-release",
    ]);
    expect(h.starts).toBe(1);
    expect(h.client.busy).toBe(false);
    expect(h.failures).toHaveLength(0);
  } finally {
    h.cleanup();
  }
});

test("real subprocess response framing preserves byte-split UTF-8 and CRLF", async () => {
  const progress: string[] = [];
  const h = harness(
    `import sys,json,time
for line in sys.stdin:
 request = json.loads(line)
 output = 'ordinary log\\r\\n@delulu-progress:Loading 👋\\r\\n@delulu:'+json.dumps({'id':request['id'],'ok':True,'result':'👋é'},ensure_ascii=False)+'\\r\\n'
 for byte in output.encode('utf-8'):
  sys.stdout.buffer.write(bytes([byte]))
  sys.stdout.buffer.flush()
  time.sleep(0.0001)
`,
    { onProgress: (detail) => progress.push(detail) },
  );
  try {
    expect(await h.client.request<string>("ping", {}, 3000)).toBe("👋é");
    expect(progress).toEqual(["Loading 👋"]);
    expect(h.failures).toHaveLength(0);
  } finally {
    h.cleanup();
  }
});

test("EOF delivers a final protocol response without a trailing newline", async () => {
  const h = harness(`import sys,json
request=json.loads(sys.stdin.readline())
sys.stdout.write('@delulu:'+json.dumps({'id':request['id'],'ok':True,'result':'final 👋'},ensure_ascii=False))
sys.stdout.flush()
`);
  try {
    expect(await h.client.request<string>("ping", {}, 3000)).toBe("final 👋");
    expect(h.client.busy).toBe(false);
  } finally {
    h.cleanup();
  }
});

test("exact response-line UTF-8 budget succeeds and one excess byte stops the generation", async () => {
  const bytes = Buffer.byteLength(
    `@delulu:${JSON.stringify({ id: "0".repeat(36), ok: true, result: "👋" })}`,
  );
  const h = harness(
    `import sys,json
for line in sys.stdin:
 request=json.loads(line)
 result='👋x' if request['command']=='over' else '👋'
 print('@delulu:'+json.dumps({'id':request['id'],'ok':True,'result':result},ensure_ascii=False,separators=(',',':')),end='\\r\\n',flush=True)
`,
    { limits: { stdoutLineBytes: bytes } },
  );
  try {
    expect(await h.client.request<string>("exact", {}, 3000)).toBe("👋");
    expect(h.failures).toHaveLength(0);
    await expect(h.client.request("over", {}, 3000)).rejects.toThrow(
      `stdout line exceeds ${bytes}`,
    );
    expect(h.failures).toHaveLength(1);
    expect(h.client.busy).toBe(false);
    expect(await h.client.request<string>("exact", {}, 3000)).toBe("👋");
    expect(h.starts).toBe(2);
  } finally {
    h.cleanup();
  }
});

test("ordinary stdout logs obey the same exact-line bound as responses", async () => {
  const h = harness(
    `import sys,json
for line in sys.stdin:
 request=json.loads(line)
 print('x'*(129 if request['command']=='over' else 128),flush=True)
 print('@delulu:'+json.dumps({'id':request['id'],'ok':True,'result':'healthy'}),flush=True)
`,
    { limits: { stdoutLineBytes: 128 } },
  );
  try {
    expect(await h.client.request<string>("exact", {}, 3000)).toBe("healthy");
    await expect(h.client.request("over", {}, 3000)).rejects.toThrow(
      "stdout line exceeds 128",
    );
    expect(h.failures).toHaveLength(1);
    expect(h.client.running).toBe(false);
    expect(h.client.busy).toBe(false);
  } finally {
    h.cleanup();
  }
});

test("overlong unterminated stdout stops once, rejects pending work, and retries cleanly", async () => {
  const h = harness(
    `import sys,json,time
for line in sys.stdin:
 request=json.loads(line)
 if request['command']=='overflow':
  sys.stdout.write('x'*129)
  sys.stdout.flush()
  time.sleep(60)
 else:
  print('@delulu:'+json.dumps({'id':request['id'],'ok':True,'result':'recovered'}),flush=True)
`,
    { limits: { stdoutLineBytes: 128 } },
  );
  try {
    const results = await Promise.allSettled([
      h.client.request("overflow", {}, 3000),
      h.client.request("pending", {}, 3000),
    ]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected")
        expect(result.reason.message).toContain("stdout line exceeds 128");
    }
    expect(h.failures).toHaveLength(1);
    expect(h.client.running).toBe(false);
    expect(h.client.busy).toBe(false);
    expect(await h.client.request<string>("ping", {}, 3000)).toBe("recovered");
    expect(h.starts).toBe(2);
    expect(h.failures).toHaveLength(1);
  } finally {
    h.cleanup();
  }
});

test("stdout overflow cannot leak buffered progress into a new generation", async () => {
  const retry: { promise?: Promise<string> } = {};
  const progress: string[] = [];
  const h = harness(
    `import sys,json
for line in sys.stdin:
 request=json.loads(line)
 if request['command']=='overflow':
  sys.stdout.write('x'*129+'\\n@delulu-progress:obsolete\\n')
  sys.stdout.flush()
 else:
  print('@delulu:'+json.dumps({'id':request['id'],'ok':True,'result':'fresh'}),flush=True)
`,
    {
      limits: { stdoutLineBytes: 128 },
      onProgress: (detail) => progress.push(detail),
      onFailure: () => {
        retry.promise ??= h.client.request<string>("ping", {}, 3000);
        void retry.promise.catch(() => undefined);
      },
    },
  );
  try {
    await expect(h.client.request("overflow", {}, 3000)).rejects.toThrow(
      "stdout line exceeds 128",
    );
    expect(await retry.promise).toBe("fresh");
    expect(progress).toEqual([]);
    expect(h.failures).toHaveLength(1);
    expect(h.starts).toBe(2);
  } finally {
    h.cleanup();
  }
});

test("repeated subprocess stderr retains a valid byte-bounded Unicode tail", async () => {
  const h = harness(
    `import sys,json
for line in sys.stdin:
 request=json.loads(line)
 for _ in range(100):
  for byte in 'older 👋é\\n'.encode('utf-8'):
   sys.stderr.buffer.write(bytes([byte]))
   sys.stderr.buffer.flush()
 print('@delulu:'+json.dumps({'id':request['id'],'ok':True,'result':'logged'}),flush=True)
`,
    { limits: { stderrBytes: 17 } },
  );
  try {
    expect(await h.client.request<string>("ping", {}, 3000)).toBe("logged");
    // Stdout and stderr are independent pipes; ensure the final log bytes arrived.
    await h.client.stopAndWait();
    expect(Buffer.byteLength(h.client.stderr)).toBeLessThanOrEqual(17);
    expect(h.client.stderr).not.toContain("�");
    expect(h.client.stderr).toContain("👋é");
    expect(h.failures).toHaveLength(0);
  } finally {
    h.cleanup();
  }
});

test("desktop transport and real Python entrypoint agree at the default request byte boundary", async () => {
  const failures: Error[] = [];
  const client = new WorkerClient(
    () => ({
      python: "python3",
      script: fileURLToPath(
        new URL("../python/transcription_engine.py", import.meta.url),
      ),
      env: process.env,
    }),
    (error) => failures.push(error),
  );
  const overhead = Buffer.byteLength(
    JSON.stringify({ text: "", id: "0".repeat(36), command: "status" }),
  );
  const remaining = DEFAULT_WORKER_PROTOCOL_LIMITS.requestBytes - overhead;
  const text =
    "👋".repeat(Math.floor(remaining / 4)) + "x".repeat(remaining % 4);
  try {
    expect(
      (await client.request<{ loaded: boolean }>("status", { text }, 3000))
        .loaded,
    ).toBe(false);
    await expect(
      client.request("status", { text: text + "x" }, 3000),
    ).rejects.toThrow("UTF-8 bytes");
    await expect(
      client.request("fixture-unknown-command", {}, 3000),
    ).rejects.toThrow("Unknown worker command");
    expect(
      (await client.request<{ loaded: boolean }>("magicStatus", {}, 3000))
        .loaded,
    ).toBe(false);
    expect(client.running).toBe(true);
    expect(client.busy).toBe(false);
    expect(failures).toEqual([]);
  } finally {
    await client.stopAndWait();
  }
});
