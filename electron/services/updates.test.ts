import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { UpdateStatus } from "../../src/types";
import { UpdateService, type UpdaterPort } from "./updates";

class FakeUpdater extends EventEmitter implements UpdaterPort {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  checks = 0;
  downloads = 0;
  installs = 0;
  async checkForUpdates() { this.checks += 1; }
  async downloadUpdate() { this.downloads += 1; }
  quitAndInstall() { this.installs += 1; }
}

describe("application updates", () => {
  test("exposes update availability, progress, and restart readiness", async () => {
    const updater = new FakeUpdater();
    const states: UpdateStatus[] = [];
    const service = new UpdateService(updater, "2.0.0", (status) => states.push(status));
    service.start();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);

    updater.emit("update-available", { version: "2.1.0" });
    await service.download();
    expect(updater.downloads).toBe(1);
    updater.emit("download-progress", { percent: 42.5, transferred: 425, total: 1000, bytesPerSecond: 200 });
    expect(service.getStatus()).toMatchObject({ phase: "downloading", version: "2.1.0", percent: 42.5 });
    updater.emit("update-downloaded", { version: "2.1.0" });
    service.install();
    expect(updater.installs).toBe(1);
    expect(states.at(-1)?.phase).toBe("downloaded");
  });

  test("keeps development builds away from the production feed", async () => {
    const service = new UpdateService(null, "2.0.0", () => undefined);
    expect((await service.check()).phase).toBe("unsupported");
  });
});
