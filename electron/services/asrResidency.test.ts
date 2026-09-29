import { expect, test } from "bun:test";

const asrUrl = new URL("./asr.ts", import.meta.url).href;
const workerUrl = new URL("../runtime/workerClient.ts", import.meta.url).href;
const installerUrl = new URL("../runtime/installer.ts", import.meta.url).href;
const dataUrl = new URL("../../src/data.ts", import.meta.url).href;

// Each child gets its own Electron/worker mocks and deterministic clock. The
// actual AsrService owns all operation reservations, deadlines and load ordering.
const harness = `
  import { mock } from "bun:test";
  import assert from "node:assert/strict";
  import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  const root = mkdtempSync(join(tmpdir(), "delulu-asr-residency-"));
  const python = join(root, "fixture-python");
  writeFileSync(python, "fixture; never executed");
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const ticks = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
  const scheduled = new Map();
  let timerId = 0;
  globalThis.setTimeout = (callback, delay) => {
    const handle = { id: ++timerId, unref() { return this; } };
    scheduled.set(handle, { callback, delay });
    return handle;
  };
  globalThis.clearTimeout = (handle) => scheduled.delete(handle);
  const deadlines = () => [...scheduled.values()];
  const fire = async (deadline) => {
    for (const [handle, item] of scheduled) if (item === deadline) scheduled.delete(handle);
    deadline.callback();
    await ticks();
  };
  const workers = [];
  const events = [];
  class FixtureWorker {
    requests = [];
    active = 0;
    stops = 0;
    gate = null;
    stopGate = null;
    stderr = "";
    constructor() { this.name = workers.length === 0 ? "speech" : "magic"; workers.push(this); }
    get busy() { return this.active > 0; }
    async request(command) {
      this.requests.push(command);
      events.push(this.name + ":" + command);
      this.active++;
      try {
        if (this.gate) await this.gate.promise;
        return { text: "Fixture output", device: "fixture", processingTimeMs: 1 };
      } finally { this.active--; }
    }
    async stopAndWait() {
      this.stops++;
      events.push(this.name + ":stop:start");
      if (this.stopGate) await this.stopGate.promise;
      events.push(this.name + ":stop:end");
    }
  }
  const installers = [];
  class FixtureInstaller {
    python = python;
    installGate = null;
    constructor() { installers.push(this); }
    async ready() { return true; }
    stop() {}
    rollback() {}
    async install(_kind, _settings, progress) {
      if (!this.installGate) throw new Error("Unexpected installer invocation");
      progress({ message: "Fixture installation", progress: 0.5 });
      await this.installGate.promise;
    }
  }
  mock.module("electron", () => ({ app: { isPackaged: false, getAppPath: () => root } }));
  mock.module(${JSON.stringify(workerUrl)}, () => ({ WorkerClient: FixtureWorker, transcriptionTimeout: () => 120000 }));
  mock.module(${JSON.stringify(installerUrl)}, () => ({ RuntimeInstaller: FixtureInstaller }));
  const { DEFAULT_SETTINGS } = await import(${JSON.stringify(dataUrl)});
  const { AsrService } = await import(${JSON.stringify(asrUrl)});
  let settings = { ...DEFAULT_SETTINGS, preloadModel: false, preloadMagicModel: false, modelIdleMinutes: 2 };
  let captureActive = false;
  const storage = {
    dataDirectory: root, venvDirectory: root, magicVenvDirectory: root,
    legacyVenvDirectory: join(root, "absent-legacy"), modelCacheDirectory: root,
    getSettings: () => ({ ...settings }),
  };
  const service = new AsrService(storage, () => !captureActive);
  const [speech, magic] = workers;
  const rewriteRequest = { text: "Fixture source", preset: "concise", allowInferences: false };
  const primeSpeech = () => service.loadModel({ ...settings });
  const primeMagic = () => service.loadMagic({ ...settings });
  try {
`;

async function verify(body: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `${harness}\n${body}\nprocess.stdout.write("verified");
      } finally { rmSync(root, { recursive: true, force: true }); }`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, diagnostic, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, diagnostic).toBe(0);
  expect(output).toBe("verified");
}

for (const phase of ["opening", "listening", "stopping"]) {
  test(`idle deadline defers without error while capture is ${phase}`, () =>
    verify(`
      await primeSpeech();
      service.setActivity(${JSON.stringify(phase === "listening" ? "listening" : "idle")}, ${JSON.stringify(phase)});
      captureActive = true;
      await fire(deadlines()[0]);
      assert.equal(speech.stops, 0);
      assert.equal(service.getStatus().engine, "ready");
      assert.equal(deadlines().length, 1, "blocked deadline must be rearmed");
      captureActive = false;
      await fire(deadlines()[0]);
      assert.equal(speech.stops, 1);
      assert.equal(service.getStatus().engine, "unloaded");
    `));
}

for (const kind of ["speech", "magic"]) {
  test(`${kind} request reserves busy ownership before asynchronous load checks`, () =>
    verify(`
      await ${kind === "speech" ? "primeSpeech" : "primeMagic"}();
      const queuedDeadline = deadlines()[0];
      const preflight = deferred();
      service.${kind === "speech" ? "ensureLoaded" : "ensureMagicLoaded"} = () => preflight.promise;
      const operation = ${kind === "speech" ? "service.transcribe({ durationMs: 1000 }, settings)" : "service.rewriteMagic(rewriteRequest, settings)"};
      assert.equal(service.isBusy, true, "pending user request must reserve ownership immediately");
      await fire(queuedDeadline);
      assert.equal(${kind}.stops, 0);
      assert.equal(service.${kind === "speech" ? "getStatus" : "getMagicStatus"}().engine, "ready");
      preflight.resolve();
      await operation;
      assert.equal(service.isBusy, false);
      assert.equal(deadlines().length, 1);
    `));
}

test("speech idle deadline defers during another backend's pending request", () =>
  verify(`
    await primeSpeech();
    await primeMagic();
    const speechDeadline = deadlines()[0];
    magic.gate = deferred();
    const rewrite = service.rewriteMagic(rewriteRequest, settings);
    await ticks();
    assert.equal(magic.busy, true);
    await fire(speechDeadline);
    assert.equal(speech.stops, 0);
    assert.equal(service.getStatus().engine, "ready");
    magic.gate.resolve();
    await rewrite;
    assert.equal(service.isBusy, false);
    assert.equal(deadlines().length, 2);
  `));

test("idle deadline defers while setup is queued in shared maintenance", () =>
  verify(`
    await primeSpeech();
    const deadline = deadlines()[0];
    const gate = deferred();
    const maintenance = service.maintenance.run(() => gate.promise);
    await ticks();
    await fire(deadline);
    assert.equal(speech.stops, 0);
    assert.equal(service.getStatus().engine, "ready");
    assert.equal(deadlines().length, 1);
    gate.resolve();
    await maintenance;
    await fire(deadlines()[0]);
    assert.equal(speech.stops, 1);
  `));

for (const kind of ["speech", "magic"]) {
  test(`${kind} request waits for an in-flight unload, then reloads before inference`, () =>
    verify(`
      await ${kind === "speech" ? "primeSpeech" : "primeMagic"}();
      events.length = 0;
      ${kind}.requests.length = 0;
      ${kind}.stopGate = deferred();
      await fire(deadlines()[0]);
      assert.equal(service.isBusy, true, "asynchronous unloading must reserve ownership");
      const operation = ${kind === "speech" ? "service.transcribe({ durationMs: 1000 }, settings)" : "service.rewriteMagic(rewriteRequest, settings)"};
      await ticks();
      assert.deepEqual(${kind}.requests, [], "old ready status must not allow premature inference");
      ${kind}.stopGate.resolve();
      await operation;
      assert.deepEqual(events, [${JSON.stringify(`${kind}:stop:start`)}, ${JSON.stringify(`${kind}:stop:end`)}, ${JSON.stringify(kind === "speech" ? "speech:load" : "magic:magicLoad")}, ${JSON.stringify(kind === "speech" ? "speech:transcribe" : "magic:magicRewrite")}]);
      assert.equal(service.isBusy, false);
      assert.equal(service.${kind === "speech" ? "getStatus" : "getMagicStatus"}().engine, "ready");
    `));
}

for (const kind of ["speech", "magic"]) {
  test(`${kind} completion respects keep-loaded settings changed during inference`, () =>
    verify(`
      await ${kind === "speech" ? "primeSpeech" : "primeMagic"}();
      ${kind}.gate = deferred();
      const operation = ${kind === "speech" ? "service.transcribe({ durationMs: 1000 }, { ...settings })" : "service.rewriteMagic(rewriteRequest, { ...settings })"};
      await ticks();
      settings = { ...settings, ${kind === "speech" ? "preloadModel" : "preloadMagicModel"}: true };
      service.configureResidency(settings);
      ${kind}.gate.resolve();
      await operation;
      assert.equal(deadlines().length, 0, "old operation settings must not rearm idle unloading");
      assert.equal(service.${kind === "speech" ? "getStatus" : "getMagicStatus"}().engine, "ready");
    `));
}

test("completion rearms with the latest idle duration instead of the operation snapshot", () =>
  verify(`
    await primeSpeech();
    speech.gate = deferred();
    const operation = service.transcribe({ durationMs: 1000 }, { ...settings });
    await ticks();
    settings = { ...settings, modelIdleMinutes: 7 };
    service.configureResidency(settings);
    speech.gate.resolve();
    await operation;
    assert.equal(deadlines().length, 1);
    assert.equal(deadlines()[0].delay, 7 * 60000);
  `));

test("turning off keep-loaded during another backend operation still schedules idle eviction", () =>
  verify(`
    settings = { ...settings, preloadModel: true };
    await primeSpeech();
    await primeMagic();
    magic.gate = deferred();
    const rewrite = service.rewriteMagic(rewriteRequest, { ...settings });
    await ticks();
    settings = { ...settings, preloadModel: false };
    service.configureResidency(settings);
    magic.gate.resolve();
    await rewrite;
    assert.equal(deadlines().length, 2, "speech setting must not be dropped while Magic is busy");
  `));

for (const kind of ["speech", "magic"]) {
  test(`${kind} failed preflight releases its reservation and intentional retry rearms eviction`, () =>
    verify(`
      await ${kind === "speech" ? "primeSpeech" : "primeMagic"}();
      const originalEnsure = service.${kind === "speech" ? "ensureLoaded" : "ensureMagicLoaded"}.bind(service);
      service.${kind === "speech" ? "ensureLoaded" : "ensureMagicLoaded"} = async () => { throw new Error("Fixture preflight failure"); };
      await assert.rejects(() => ${kind === "speech" ? "service.transcribe({ durationMs: 1000 }, settings)" : "service.rewriteMagic(rewriteRequest, settings)"}, /Fixture preflight failure/);
      assert.equal(service.isBusy, false);
      assert.equal(deadlines().length, ${kind === "speech" ? "1" : "0"}, "ready speech may rearm; failed writing must wait for explicit retry");
      service.${kind === "speech" ? "ensureLoaded" : "ensureMagicLoaded"} = originalEnsure;
      await ${kind === "speech" ? "service.transcribe({ durationMs: 1000 }, settings)" : "service.rewriteMagic(rewriteRequest, settings)"};
      assert.equal(service.isBusy, false);
      assert.equal(deadlines().length, 1);
    `));
}

test("shutdown removes both resident-model deadlines without rearming", () =>
  verify(`
    await primeSpeech();
    await primeMagic();
    assert.equal(deadlines().length, 2);
    await service.shutdown();
    assert.equal(deadlines().length, 0);
    assert.equal(speech.stops, 1);
    assert.equal(magic.stops, 1);
  `));

for (const kind of ["speech", "magic"]) {
  const other = kind === "speech" ? "magic" : "speech";
  const flag = kind === "speech" ? "preloadMagicModel" : "preloadModel";
  const load = kind === "speech" ? "magicLoad" : "load";
  for (const cancel of [false, true]) {
    test(`${kind} completion ${cancel ? "cancels" : "applies"} deferred keep-loaded on the unloaded ${other} backend`, () =>
      verify(`
        await service.initialize(settings);
        await ${kind === "speech" ? "primeSpeech" : "primeMagic"}();
        assert.equal(service.${kind === "speech" ? "getMagicStatus" : "getStatus"}().engine, "unloaded");
        ${kind}.gate = deferred();
        const operation = ${kind === "speech" ? "service.transcribe({ durationMs: 1000 }, { ...settings })" : "service.rewriteMagic(rewriteRequest, { ...settings })"};
        await ticks();
        settings = { ...settings, ${flag}: true };
        service.configureResidency(settings);
        assert.deepEqual(${other}.requests, [], "deferred preload must not overlap pending user work");
        ${
          cancel
            ? `settings = { ...settings, ${flag}: false }; service.configureResidency(settings);`
            : ""
        }
        ${kind}.gate.resolve();
        await operation;
        await ticks();
        assert.deepEqual(${other}.requests, ${cancel ? "[]" : JSON.stringify([load])});
        assert.equal(service.isBusy, false);
        assert.equal(service.${kind === "speech" ? "getMagicStatus" : "getStatus"}().engine, ${JSON.stringify(cancel ? "unloaded" : "ready")});
      `));
  }
}

test("deferred keep-loaded on the other backend runs after shared setup finishes", () =>
  verify(`
    await service.initialize(settings);
    installers[0].installGate = deferred();
    const setup = service.setup({ ...settings });
    await ticks();
    settings = { ...settings, preloadMagicModel: true };
    service.configureResidency(settings);
    assert.deepEqual(magic.requests, []);
    installers[0].installGate.resolve();
    await setup;
    await ticks();
    assert.deepEqual(magic.requests, ["magicLoad"]);
    assert.equal(service.isBusy, false);
    assert.equal(service.getMagicStatus().engine, "ready");
  `));

for (const kind of ["speech", "magic"]) {
  test(`${kind} completion after shutdown cannot resurrect idle deadlines`, () =>
    verify(`
      await ${kind === "speech" ? "primeSpeech" : "primeMagic"}();
      ${kind}.gate = deferred();
      const operation = ${kind === "speech" ? "service.transcribe({ durationMs: 1000 }, settings)" : "service.rewriteMagic(rewriteRequest, settings)"};
      await ticks();
      assert.equal(service.isBusy, true);
      await service.shutdown();
      assert.equal(deadlines().length, 0);
      ${kind}.gate.resolve();
      await operation;
      await ticks();
      assert.equal(service.isBusy, false);
      assert.equal(deadlines().length, 0);
    `));

  test(`${kind} pending ready check cannot send inference after shutdown starts`, () =>
    verify(`
      await ${kind === "speech" ? "primeSpeech" : "primeMagic"}();
      ${kind}.requests.length = 0;
      const operation = ${kind === "speech" ? "service.transcribe({ durationMs: 1000 }, settings)" : "service.rewriteMagic(rewriteRequest, settings)"};
      const rejection = assert.rejects(() => operation, /shutting down/);
      await service.shutdown();
      await rejection;
      assert.deepEqual(${kind}.requests, [], "awaited ready checks must not revive a stopped worker");
      assert.equal(service.isBusy, false);
      assert.equal(deadlines().length, 0);
    `));
}
