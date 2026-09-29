import { expect, test } from "bun:test";

const asrUrl = new URL("./asr.ts", import.meta.url).href;
const workerUrl = new URL("../runtime/workerClient.ts", import.meta.url).href;
const dataUrl = new URL("../../src/data.ts", import.meta.url).href;
const fixtureUrl = new URL(
  "../runtime/fixtures/setupPython.ts",
  import.meta.url,
).href;
const locationUrl = new URL("../runtime/location.ts", import.meta.url).href;
const processTest = test.skipIf(process.platform === "win32");
const permissionTest = test.skipIf(
  process.platform === "win32" || process.geteuid?.() === 0,
);

// Actual AsrService, RuntimeInstaller, spawned installer fixtures and activation
// files. Only Electron and the model-worker boundary are mocked, in a child so
// module mocks cannot leak into the rest of the test suite.
const harness = `
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
const { createSetupFixture } = await import(${JSON.stringify(fixtureUrl)});
const { activateRuntime, runtimePython, runtimeDirectory } = await import(${JSON.stringify(locationUrl)});
const root = mkdtempSync(join(tmpdir(), "delulu-setup-recovery-"));
process.resourcesPath = root;
const fixture = createSetupFixture(root);
Object.assign(process.env, fixture.environment);
const speechRoot = join(root, "speech");
const magicRoot = join(root, "magic");
const profileFiles = ["settings.json", "history.json"];
for (const name of profileFiles) writeFileSync(join(root, name), "Original " + name);
const cache = join(root, "model-cache");
mkdirSync(cache, { recursive: true });
writeFileSync(join(cache, "existing-weight"), "original model cache");
mkdirSync(join(root, "electron/python"), { recursive: true });
writeFileSync(join(root, "electron/python/constraints-linux-x64.txt"), "# fixture: no packages installed\\n");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const workers = [];
const calls = [];
const failures = [];
const statuses = { speech: [], magic: [] };
class ModelWorkerFixture {
  stderr = "";
  active = 0;
  stopped = 0;
  loadGate = null;
  loadEntered = null;
  nextFailure = null;
  denyRollback = false;
  constructor(paths) {
    this.paths = paths;
    this.kind = workers.length === 0 ? "speech" : "magic";
    workers.push(this);
  }
  get busy() { return this.active > 0; }
  async request(command) {
    const paths = this.paths();
    calls.push({ kind: this.kind, command, python: paths.python });
    assert.ok(existsSync(paths.python), "model load must use installed candidate interpreter");
    this.active++;
    this.loadEntered?.resolve();
    try {
      if (this.loadGate) await this.loadGate.promise;
      if (this.nextFailure) {
        const error = this.nextFailure;
        this.nextFailure = null;
        writeFileSync(join(cache, this.kind + "-download.partial"), "synthetic interrupted weights");
        if (this.denyRollback) chmodSync(this.kind === "speech" ? speechRoot : magicRoot, 0o500);
        throw error;
      }
      return { device: "fixture", text: "fixture" };
    } finally { this.active--; }
  }
  async stopAndWait() {
    this.stopped++;
    if (this.active) {
      this.loadGate?.reject(new Error("Fixture model worker stopped"));
      this.loadGate = null;
    }
  }
}

mock.module("electron", () => ({ app: { isPackaged: false, getAppPath: () => root } }));
mock.module(${JSON.stringify(workerUrl)}, () => ({ WorkerClient: ModelWorkerFixture, transcriptionTimeout: () => 120000 }));
const { DEFAULT_SETTINGS } = await import(${JSON.stringify(dataUrl)});
const { AsrService } = await import(${JSON.stringify(asrUrl)});
let settings = { ...DEFAULT_SETTINGS, pythonCommand: fixture.program, preloadModel: false, preloadMagicModel: false };
const storage = {
  dataDirectory: root, venvDirectory: speechRoot, magicVenvDirectory: magicRoot,
  legacyVenvDirectory: join(root, "legacy-unused"), modelCacheDirectory: cache,
  getSettings: () => ({ ...settings }),
};
function seed(runtimeRoot, state) {
  if (state === "fresh") return null;
  mkdirSync(runtimeRoot, { recursive: true });
  if (state === "generation") activateRuntime(runtimeRoot, "12345678-1234-1234-1234-123456789abc");
  const python = runtimePython(runtimeRoot);
  mkdirSync(dirname(python), { recursive: true });
  copyFileSync(fixture.program, python);
  chmodSync(python, 0o700);
  writeFileSync(join(runtimeDirectory(runtimeRoot), "old-runtime-report.txt"), "original dependency report");
  return { python, bytes: readFileSync(python), report: join(runtimeDirectory(runtimeRoot), "old-runtime-report.txt") };
}
const service = new AsrService(storage);
service.onStatus(value => statuses.speech.push(value));
service.onMagicStatus(value => statuses.magic.push(value));
const [speechWorker, magicWorker] = workers;
const runSetup = kind => kind === "speech" ? service.setup(settings) : service.setupMagic(settings);
const getStatus = kind => kind === "speech" ? service.getStatus() : service.getMagicStatus();
const runtimeRoot = kind => kind === "speech" ? speechRoot : magicRoot;
const worker = kind => kind === "speech" ? speechWorker : magicWorker;
function originalProfileIntact() {
  for (const name of profileFiles) assert.equal(readFileSync(join(root, name), "utf8"), "Original " + name);
  assert.equal(readFileSync(join(cache, "existing-weight"), "utf8"), "original model cache");
}
try {
`;

async function verify(body: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `${harness}\n${body}\nprocess.stdout.write("verified");
      } finally {
        await service.shutdown();
        for (const directory of [speechRoot, magicRoot]) if (existsSync(directory)) chmodSync(directory, 0o700);
        rmSync(root, { recursive: true, force: true });
      }`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const deadline = setTimeout(() => child.kill(), 25_000);
  try {
    const [output, diagnostic, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, diagnostic).toBe(0);
    expect(output).toBe("verified");
  } finally {
    clearTimeout(deadline);
  }
}

for (const kind of ["speech", "magic"] as const) {
  processTest(
    `${kind} failed restoration of the other preloaded model rolls back the setup candidate`,
    () =>
      verify(`
        const kind = ${JSON.stringify(kind)};
        const otherKind = kind === "speech" ? "magic" : "speech";
        const old = seed(runtimeRoot(kind), "generation");
        const other = seed(runtimeRoot(otherKind), "generation");
        const otherPointer = readFileSync(join(runtimeRoot(otherKind), "active.json"));
        settings[kind === "speech" ? "preloadMagicModel" : "preloadModel"] = true;
        worker(otherKind).nextFailure = new Error("Fixture opposite model restoration failed");
        await assert.rejects(runSetup(kind), /opposite model restoration failed/);
        assert.equal(runtimePython(runtimeRoot(kind)), old.python, "every failed setup stage must restore the prior active runtime");
        assert.deepEqual(readFileSync(old.python), old.bytes);
        assert.equal(readFileSync(old.report, "utf8"), "original dependency report");
        assert.deepEqual(readFileSync(join(runtimeRoot(otherKind), "active.json")), otherPointer);
        assert.deepEqual(readFileSync(other.python), other.bytes);
        assert.equal(getStatus(kind).engine, "unloaded");
        assert.equal(worker(kind).active, 0);
        assert.ok(worker(kind).stopped >= 2, "stop validated candidate worker before restoring the prior pointer");
        originalProfileIntact();
        await runSetup(kind);
        assert.equal(getStatus(kind).engine, "ready");
        assert.equal(getStatus(otherKind).engine, "ready");
        assert.notEqual(runtimePython(runtimeRoot(kind)), old.python);
        assert.equal(runtimePython(runtimeRoot(otherKind)), other.python);
        originalProfileIntact();
      `),
    30_000,
  );
}

for (const kind of ["speech", "magic"] as const) {
  for (const state of ["fresh", "legacy", "generation"] as const) {
    processTest(
      `${kind} failed model download/warmup restores ${state} runtime and allows explicit setup retry`,
      () =>
        verify(`
          const kind = ${JSON.stringify(kind)};
          const previous = seed(runtimeRoot(kind), ${JSON.stringify(state)});
          const otherKind = kind === "speech" ? "magic" : "speech";
          const other = seed(runtimeRoot(otherKind), "generation");
          const otherPointer = readFileSync(join(runtimeRoot(otherKind), "active.json"));
          worker(kind).nextFailure = new Error("Fixture model download/warmup interrupted");
          await assert.rejects(runSetup(kind), /download\\/warmup interrupted/);
          assert.equal(statuses[kind].some(status => status.engine === "ready"), false, "failed model must never publish Ready");
          assert.equal(calls.filter(call => call.kind === kind).length, 1, "failure must not automatically retry inference");
          assert.ok(worker(kind).stopped >= 2, "candidate model worker must be stopped before rollback");
          if (previous) {
            assert.equal(runtimePython(runtimeRoot(kind)), previous.python);
            assert.deepEqual(readFileSync(previous.python), previous.bytes);
            assert.equal(readFileSync(previous.report, "utf8"), "original dependency report");
            assert.equal(getStatus(kind).engine, "unloaded");
            assert.match(getStatus(kind).message, /existing.*runtime is preserved/);
          } else {
            assert.equal(existsSync(join(runtimeRoot(kind), "active.json")), false, "fresh install rollback restores legacy lookup");
            assert.equal(getStatus(kind).engine, "error");
          }
          assert.deepEqual(readFileSync(join(runtimeRoot(otherKind), "active.json")), otherPointer);
          assert.deepEqual(readFileSync(other.python), other.bytes);
          assert.equal(worker(otherKind).stopped, 0, "unrelated worker is not stopped by this setup");
          originalProfileIntact();
          const failedCandidate = calls.find(call => call.kind === kind).python;
          await runSetup(kind);
          assert.equal(getStatus(kind).engine, "ready");
          const loads = calls.filter(call => call.kind === kind);
          assert.equal(loads.length, 2);
          assert.notEqual(loads[1].python, failedCandidate, "explicit repair uses a fresh candidate");
          assert.equal(runtimePython(runtimeRoot(kind)), loads[1].python);
          if (previous) assert.deepEqual(readFileSync(previous.python), previous.bytes);
          originalProfileIntact();
        `),
      30_000,
    );
  }
}

for (const kind of ["speech", "magic"] as const) {
  processTest(
    `${kind} duplicate setup requests share one candidate and publish Ready only after model completion`,
    () =>
      verify(`
        const kind = ${JSON.stringify(kind)};
        const old = seed(runtimeRoot(kind), "generation");
        worker(kind).loadGate = deferred();
        worker(kind).loadEntered = deferred();
        const first = runSetup(kind);
        const second = runSetup(kind);
        await worker(kind).loadEntered.promise;
        assert.equal(service.isBusy, true);
        assert.equal(getStatus(kind).engine, "loading");
        assert.equal(statuses[kind].some(status => status.engine === "ready"), false);
        assert.equal(calls.filter(call => call.kind === kind).length, 1);
        worker(kind).loadGate.resolve();
        await Promise.all([first, second]);
        assert.equal(getStatus(kind).engine, "ready");
        assert.equal(service.isBusy, false);
        assert.equal(fixture.readLog().filter(entry => entry.stage === "venv" && entry.event === "start").length, 1);
        assert.deepEqual(readFileSync(old.python), old.bytes);
        originalProfileIntact();
      `),
    30_000,
  );

  processTest(
    `${kind} shutdown during model setup rolls back and allows an explicit new setup`,
    () =>
      verify(`
        const kind = ${JSON.stringify(kind)};
        const old = seed(runtimeRoot(kind), "generation");
        worker(kind).loadGate = deferred();
        worker(kind).loadEntered = deferred();
        const operation = runSetup(kind);
        const rejected = assert.rejects(operation, /Fixture model worker stopped/);
        await worker(kind).loadEntered.promise;
        assert.notEqual(runtimePython(runtimeRoot(kind)), old.python);
        await service.shutdown();
        await rejected;
        assert.equal(runtimePython(runtimeRoot(kind)), old.python);
        assert.deepEqual(readFileSync(old.python), old.bytes);
        assert.equal(statuses[kind].some(status => status.engine === "ready"), false);
        assert.equal(calls.filter(call => call.kind === kind).length, 1, "shutdown must not trigger automatic reload");
        originalProfileIntact();
        await runSetup(kind);
        assert.equal(getStatus(kind).engine, "ready");
        assert.equal(calls.filter(call => call.kind === kind).length, 2);
        assert.deepEqual(readFileSync(old.python), old.bytes);
        originalProfileIntact();
      `),
    30_000,
  );
}

for (const kind of ["speech", "magic"] as const) {
  permissionTest(
    `${kind} rollback write failure reports incomplete recovery and retains both causes`,
    () =>
      verify(`
        const kind = ${JSON.stringify(kind)};
        const old = seed(runtimeRoot(kind), "generation");
        worker(kind).denyRollback = true;
        worker(kind).nextFailure = new Error("Fixture primary model load failed");
        let error;
        try { await runSetup(kind); } catch (reason) { error = reason; }
        assert.ok(error, "failed rollback must reject setup");
        assert.match(error.message, /previous runtime could not be restored/);
        assert.ok(error.cause instanceof AggregateError);
        assert.match(error.cause.errors[0].message, /primary model load failed/);
        assert.equal(error.cause.errors[1].code, "EACCES");
        assert.equal(getStatus(kind).engine, "error", "incomplete rollback must not advertise preserved-runtime recovery");
        assert.match(getStatus(kind).message, /previous runtime could not be restored/);
        assert.notEqual(runtimePython(runtimeRoot(kind)), old.python, "report the actual incomplete pointer recovery honestly");
        assert.deepEqual(readFileSync(old.python), old.bytes);
        assert.equal(readFileSync(old.report, "utf8"), "original dependency report");
        assert.equal(statuses[kind].some(status => status.engine === "ready"), false);
        assert.ok(worker(kind).stopped >= 2);
        originalProfileIntact();
        chmodSync(runtimeRoot(kind), 0o700);
        worker(kind).denyRollback = false;
        await runSetup(kind);
        assert.equal(getStatus(kind).engine, "ready");
        assert.deepEqual(readFileSync(old.python), old.bytes);
        originalProfileIntact();
      `),
    30000,
  );
}

permissionTest(
  "rollback recovery guidance remains visible after a long model error",
  () =>
    verify(`
    const old = seed(speechRoot, "generation");
    const longMessage = "Fixture primary model load failed: " + "X".repeat(1000);
    speechWorker.denyRollback = true;
    speechWorker.nextFailure = new Error(longMessage);
    let error;
    try { await service.setup(settings); } catch (reason) { error = reason; }
    assert.ok(error);
    assert.equal(error.cause.errors[0].message, longMessage);
    assert.equal(error.cause.errors[1].code, "EACCES");
    const status = service.getStatus();
    assert.equal(status.engine, "error");
    assert.match(status.message, /previous runtime could not be restored/);
    assert.match(status.message, /retry Repair/);
    assert.ok(status.message.length <= 800);
    assert.deepEqual(readFileSync(old.python), old.bytes);
    originalProfileIntact();
  `),
  30000,
);
