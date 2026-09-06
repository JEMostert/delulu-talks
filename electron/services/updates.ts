import type { UpdateStatus } from "../../src/types";

type UpdateInfo = { version: string };
type ProgressInfo = {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
};

export type UpdaterPort = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  on(event: "checking-for-update", listener: () => void): unknown;
  on(
    event: "update-available" | "update-not-available" | "update-downloaded",
    listener: (info: UpdateInfo) => void,
  ): unknown;
  on(
    event: "download-progress",
    listener: (progress: ProgressInfo) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
};

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^Error:\s*/i, "")
    .split("\n")[0]
    .slice(0, 240);
}

export class UpdateService {
  private status: UpdateStatus;
  private started = false;
  private checking: Promise<UpdateStatus> | null = null;

  constructor(
    private readonly updater: UpdaterPort | null,
    currentVersion: string,
    private readonly publish: (status: UpdateStatus) => void,
    private readonly canInstall: () => boolean = () => true,
  ) {
    this.status = updater
      ? {
          phase: "idle",
          currentVersion,
          message: "Updates are delivered through GitHub Releases",
        }
      : {
          phase: "unsupported",
          currentVersion,
          message: "Use GitHub Releases to update this installation",
        };
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  start(): void {
    if (!this.updater || this.started) return;
    this.started = true;
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    // v0.5.0 resets the public version line after the premature v2.0.0 release.
    // Permit that one transition without allowing arbitrary future downgrades.
    this.updater.allowDowngrade = this.status.currentVersion === "2.0.0";
    this.updater.on("checking-for-update", () =>
      this.update({ phase: "checking", message: "Checking GitHub Releases…" }),
    );
    this.updater.on("update-available", (info) =>
      this.update({
        phase: "available",
        version: info.version,
        message: `Version ${info.version} is ready to download`,
        percent: 0,
      }),
    );
    this.updater.on("update-not-available", () =>
      this.update({
        phase: "upToDate",
        version: undefined,
        message: `Delulu Talks ${this.status.currentVersion} is up to date`,
        percent: undefined,
      }),
    );
    this.updater.on("download-progress", (progress) =>
      this.update({
        phase: "downloading",
        message: `Downloading version ${this.status.version ?? "update"}`,
        percent: Math.min(100, Math.max(0, progress.percent)),
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      }),
    );
    this.updater.on("update-downloaded", (info) =>
      this.update({
        phase: "downloaded",
        version: info.version,
        message: `Version ${info.version} is ready to install`,
        percent: 100,
      }),
    );
    this.updater.on("error", (error) =>
      this.update({ phase: "error", message: errorMessage(error) }),
    );
  }

  async check(): Promise<UpdateStatus> {
    if (
      !this.updater ||
      ["downloading", "downloaded"].includes(this.status.phase)
    )
      return this.getStatus();
    if (this.checking) return this.checking;
    this.start();
    this.checking = (async () => {
      this.update({ phase: "checking", message: "Checking GitHub Releases…" });
      try {
        await this.updater!.checkForUpdates();
      } catch (error) {
        this.update({ phase: "error", message: errorMessage(error) });
      }
      return this.getStatus();
    })().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  async download(): Promise<UpdateStatus> {
    if (!this.updater) return this.getStatus();
    if (
      !this.status.version ||
      (this.status.phase !== "available" && this.status.phase !== "error")
    )
      return this.getStatus();
    this.update({
      phase: "downloading",
      message: `Starting version ${this.status.version ?? "update"} download`,
      percent: 0,
    });
    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      this.update({ phase: "error", message: errorMessage(error) });
    }
    return this.getStatus();
  }

  install(): void {
    if (!this.updater || this.status.phase !== "downloaded") return;
    if (!this.canInstall())
      throw new Error(
        "Finish recording, processing, or model setup before restarting",
      );
    this.updater.quitAndInstall(false, true);
  }

  private update(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.publish(this.getStatus());
  }
}
