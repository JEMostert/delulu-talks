import type { UpdateStatus } from "../../src/types";

type UpdateInfo = { version: string };
type DownloadAttempt = { version: string; completed: boolean; confirmed: boolean };
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
  private downloading: Promise<UpdateStatus> | null = null;
  private downloadAttempt: DownloadAttempt | null = null;
  private readyVersion: string | null = null;

  constructor(
    private readonly updater: UpdaterPort | null,
    currentVersion: string,
    private readonly publish: (status: UpdateStatus) => void,
    private readonly canInstall: () => boolean = () => true,
    unsupportedMessage = "Use GitHub Releases to update this installation",
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
          message: unsupportedMessage,
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
    this.updater.on("checking-for-update", () => {
      if (this.downloadAttempt || this.readyVersion) return;
      this.update({ phase: "checking", message: "Checking GitHub Releases…" });
    });
    this.updater.on("update-available", (info) => {
      if (this.downloadAttempt || this.readyVersion) return;
      this.update({
        phase: "available",
        version: info.version,
        message: `Version ${info.version} is ready to download`,
        percent: 0,
      });
    });
    this.updater.on("update-not-available", () => {
      if (this.downloadAttempt || this.readyVersion) return;
      this.update({
        phase: "upToDate",
        version: undefined,
        message: `Delulu Talks ${this.status.currentVersion} is up to date`,
        percent: undefined,
      });
    });
    this.updater.on("download-progress", (progress) => {
      if (!this.downloadAttempt) return;
      this.update({
        phase: "downloading",
        message: `Downloading version ${this.downloadAttempt.version}`,
        percent: Math.min(100, Math.max(0, progress.percent)),
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      });
    });
    this.updater.on("update-downloaded", (info) => {
      const attempt = this.downloadAttempt;
      if (!attempt) return;
      if (info.version !== attempt.version) {
        this.downloadAttempt = null;
        this.readyVersion = null;
        this.update({ phase: "error", message: "Downloaded update does not match the selected version. Check for updates and retry." });
        return;
      }
      attempt.confirmed = true;
      this.stageCompletedDownload(attempt);
    });
    this.updater.on("error", (error) => {
      this.downloadAttempt = null;
      this.readyVersion = null;
      this.update({ phase: "error", message: errorMessage(error) });
    });
  }

  async check(): Promise<UpdateStatus> {
    if (
      !this.updater || this.downloading || this.downloadAttempt || this.readyVersion ||
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
        if (!this.downloadAttempt && !this.readyVersion)
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
    if (this.downloading) return this.downloading;
    if (this.downloadAttempt || !this.status.version ||
      (this.status.phase !== "available" && this.status.phase !== "error"))
      return this.getStatus();
    this.start();
    const attempt: DownloadAttempt = {
      version: this.status.version, completed: false, confirmed: false,
    };
    this.readyVersion = null;
    this.downloadAttempt = attempt;
    this.update({
      phase: "downloading", version: attempt.version,
      message: `Starting version ${attempt.version} download`, percent: 0,
    });
    this.downloading = (async () => {
      try {
        // The updater owns artifact validation. Both its completion promise and
        // matched downloaded event must succeed before restart becomes available.
        await this.updater!.downloadUpdate();
        if (this.downloadAttempt === attempt) {
          attempt.completed = true;
          this.stageCompletedDownload(attempt);
        }
      } catch (error) {
        if (this.downloadAttempt === attempt) {
          this.downloadAttempt = null;
          this.readyVersion = null;
          this.update({ phase: "error", message: errorMessage(error) });
        }
      }
      return this.getStatus();
    })().finally(() => { this.downloading = null; });
    return this.downloading;
  }

  private stageCompletedDownload(attempt: DownloadAttempt): void {
    if (this.downloadAttempt !== attempt || !attempt.completed || !attempt.confirmed) return;
    this.readyVersion = attempt.version;
    this.downloadAttempt = null;
    this.update({
      phase: "downloaded", version: attempt.version,
      message: `Version ${attempt.version} is ready to install`, percent: 100,
    });
  }

  install(): void {
    if (!this.updater || this.status.phase !== "downloaded" ||
        !this.readyVersion || this.status.version !== this.readyVersion) return;
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
