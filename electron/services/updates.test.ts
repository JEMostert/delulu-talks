import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import { UpdateService, type UpdaterPort } from "./updates";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const events = new EventEmitter();
  const download = deferred<void>();
  let busy = false,
    checks = 0,
    downloads = 0;
  const installations: [boolean | undefined, boolean | undefined][] = [];
  const updater: UpdaterPort = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowDowngrade: true,
    on: events.on.bind(events),
    checkForUpdates: async () => {
      checks++;
      events.emit("checking-for-update");
      events.emit("update-available", { version: "0.11.0" });
    },
    downloadUpdate: () => {
      downloads++;
      return download.promise;
    },
    quitAndInstall: (silent, forceRun) =>
      installations.push([silent, forceRun]),
  };
  const service = new UpdateService(
    updater,
    "0.10.0",
    () => {},
    () => !busy,
  );
  return {
    service,
    updater,
    events,
    download,
    installations,
    busy: (value: boolean) => {
      busy = value;
    },
    checks: () => checks,
    downloads: () => downloads,
  };
}
async function ready(f: ReturnType<typeof fixture>) {
  await f.service.check();
  const pending = f.service.download();
  f.events.emit("update-downloaded", { version: "0.11.0" });
  f.download.resolve();
  await pending;
}

test("updates never restart an active operation or install automatically; a verified idle restart launches the new app", async () => {
  const f = fixture();
  f.service.install();
  expect(f.installations).toEqual([]);
  await ready(f);
  expect(f.updater.autoDownload).toBe(false);
  expect(f.updater.autoInstallOnAppQuit).toBe(false);
  expect(f.updater.allowDowngrade).toBe(false);
  f.busy(true);
  expect(() => f.service.install()).toThrow(
    "Finish recording, processing, or model setup",
  );
  expect(f.installations).toEqual([]);
  expect(f.service.getStatus().phase).toBe("downloaded");
  f.busy(false);
  f.service.install();
  expect(f.installations).toEqual([[false, true]]);
});

test("restart requires both matching downloaded event and successful download completion in either order", async () => {
  for (const first of ["event", "completion"] as const) {
    const f = fixture();
    await f.service.check();
    const pending = f.service.download();
    const repeated = f.service.download();
    expect(f.downloads()).toBe(1);
    if (first === "event")
      f.events.emit("update-downloaded", { version: "0.11.0" });
    else {
      f.download.resolve();
      await pending;
    }
    expect(f.service.getStatus().phase).toBe("downloading");
    f.service.install();
    expect(f.installations).toEqual([]);
    if (first === "event") f.download.resolve();
    else f.events.emit("update-downloaded", { version: "0.11.0" });
    await Promise.all([pending, repeated]);
    expect(f.service.getStatus()).toMatchObject({
      phase: "downloaded",
      version: "0.11.0",
      percent: 100,
    });
  }
});

test("unsolicited and mismatched downloaded events cannot stage an artifact for restart", async () => {
  const f = fixture();
  await f.service.check();
  f.events.emit("update-downloaded", { version: "0.11.0" });
  expect(f.service.getStatus().phase).toBe("available");
  f.service.install();
  const pending = f.service.download();
  f.events.emit("update-downloaded", { version: "0.9.0" });
  f.download.resolve();
  await pending;
  expect(f.service.getStatus()).toMatchObject({
    phase: "error",
    message:
      "Downloaded update does not match the selected version. Check for updates and retry.",
  });
  f.events.emit("update-downloaded", { version: "0.11.0" });
  f.service.install();
  expect(f.installations).toEqual([]);
});

test("promise rejection or updater error after a downloaded event blocks restart and permits a fresh verified retry", async () => {
  for (const source of ["promise", "event"] as const) {
    const f = fixture();
    await f.service.check();
    const pending = f.service.download();
    f.events.emit("update-downloaded", { version: "0.11.0" });
    if (source === "promise")
      f.download.reject(new Error("Checksum validation failed"));
    else {
      f.events.emit("error", new Error("Checksum validation failed"));
      f.download.resolve();
    }
    await pending;
    f.service.install();
    expect(f.service.getStatus()).toMatchObject({
      phase: "error",
      message: "Checksum validation failed",
    });
    expect(f.installations).toEqual([]);
    const retry = deferred<void>();
    f.updater.downloadUpdate = () => retry.promise;
    const retried = f.service.download();
    f.events.emit("update-downloaded", { version: "0.11.0" });
    retry.resolve();
    await retried;
    f.service.install();
    expect(f.installations).toEqual([[false, true]]);
  }
});

test("repeated checks and late check errors preserve a verified update instead of forcing another download", async () => {
  const f = fixture();
  await ready(f);
  const readyStatus = f.service.getStatus();
  await Promise.all([
    f.service.check(),
    f.service.check(),
    f.service.download(),
  ]);
  f.events.emit("checking-for-update");
  f.events.emit("update-not-available", { version: "0.10.0" });
  f.events.emit("update-available", { version: "0.12.0" });
  f.events.emit("error", new Error("Late check could not reach GitHub"));
  expect(f.checks()).toBe(1);
  expect(f.downloads()).toBe(1);
  expect(f.service.getStatus()).toEqual(readyStatus);
  f.service.install();
  expect(f.installations).toEqual([[false, true]]);
});

test("an installation request is idempotent until exit or failure, and asynchronous or thrown installer errors enable a verified retry", async () => {
  for (const source of ["event", "throw"] as const) {
    const f = fixture();
    await ready(f);
    let requests = 0;
    f.updater.quitAndInstall = () => {
      requests++;
      if (source === "throw") throw new Error("Installer unavailable");
    };
    if (source === "throw")
      expect(() => f.service.install()).toThrow("Installer unavailable");
    else {
      f.service.install();
      f.service.install();
      expect(requests).toBe(1);
      // The error arrives on a later turn, after quitAndInstall returned.
      await Promise.resolve();
      f.events.emit("error", new Error("Installer unavailable"));
    }
    expect(f.service.getStatus()).toMatchObject({ phase: "error" });
    expect(f.service.getStatus().message).toContain("Installer unavailable");
    expect(f.service.getStatus().message).toContain("retry");
    f.service.install();
    expect(requests).toBe(1);
    const retry = deferred<void>();
    f.updater.downloadUpdate = () => retry.promise;
    await f.service.check();
    const pending = f.service.download();
    f.events.emit("update-downloaded", { version: "0.11.0" });
    retry.resolve();
    await pending;
    f.updater.quitAndInstall = () => {
      requests++;
    };
    f.service.install();
    f.service.install();
    expect(requests).toBe(2);
  }
});
