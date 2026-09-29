import { randomUUID } from "node:crypto";
import type { PasteLastStatus } from "../../src/types";

export class PasteLastService {
  private status: PasteLastStatus = {
    phase: "idle",
    operationId: null,
    dueAt: null,
    remainingSeconds: 0,
    message: "",
  };
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ports: {
      captureActive(): boolean;
      currentText(id: string): string | null;
      paste(text: string): Promise<string>;
      copy(text: string): void;
      clipboardOnly(): boolean;
      changed(status: PasteLastStatus): void;
    },
  ) {}

  getStatus(): PasteLastStatus {
    return { ...this.status };
  }

  private publish(patch: Partial<PasteLastStatus>) {
    this.status = { ...this.status, ...patch };
    this.ports.changed(this.getStatus());
  }

  private clearTimer() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  start(
    recordId: string,
    text: string,
    delaySeconds: number,
  ): PasteLastStatus {
    if (["pending", "delivering"].includes(this.status.phase))
      throw new Error(
        "A paste is already scheduled or being attempted. Cancel the countdown before scheduling another.",
      );
    if (this.ports.captureActive())
      throw new Error("Finish the current recording first");
    if (
      !Number.isInteger(delaySeconds) ||
      delaySeconds < 1 ||
      delaySeconds > 30
    )
      throw new Error("Paste delay must be a whole number from 1 to 30 seconds");
    this.clearTimer();
    const operationId = randomUUID();
    const dueAt = Date.now() + delaySeconds * 1000;
    this.publish({
      phase: "pending",
      operationId,
      dueAt,
      remainingSeconds: delaySeconds,
      message:
        "Focus the intended text field. You can cancel until the countdown ends.",
    });
    this.timer = setInterval(() => {
      if (
        this.status.operationId !== operationId ||
        this.status.phase !== "pending"
      )
        return;
      if (this.ports.captureActive()) {
        this.cancel(operationId, "Paste cancelled because a recording started.");
        return;
      }
      const current = this.ports.currentText(recordId);
      if (current === null || current !== text) {
        this.cancel(
          operationId,
          "Paste cancelled because the transcript was removed or changed.",
        );
        return;
      }
      const remainingSeconds = Math.max(
        0,
        Math.ceil((dueAt - Date.now()) / 1000),
      );
      if (remainingSeconds !== this.status.remainingSeconds)
        this.publish({ remainingSeconds });
      if (remainingSeconds === 0) {
        this.clearTimer();
        this.publish({
          phase: "delivering",
          dueAt: null,
          message:
            "Attempting delivery. Cancellation is no longer available once delivery starts.",
        });
        void this.deliver(operationId, text);
      }
    }, 100);
    return this.getStatus();
  }

  private async deliver(operationId: string, text: string) {
    try {
      if (this.ports.clipboardOnly()) {
        this.ports.copy(text);
        this.publish({
          phase: "copied",
          message:
            "Copied to clipboard. Automatic paste is unavailable on this desktop; paste manually in the intended field.",
        });
      } else {
        await this.ports.paste(text);
        if (this.status.operationId === operationId)
          this.publish({
            phase: "attempted",
            message:
              "Paste keystrokes sent. Check the intended field; the destination has not confirmed insertion.",
          });
      }
    } catch (reason) {
      if (this.status.operationId === operationId)
        this.publish({
          phase: "error",
          message: reason instanceof Error ? reason.message : String(reason),
        });
    }
  }

  cancel(
    operationId: string,
    message = "Scheduled paste cancelled.",
  ): PasteLastStatus {
    if (
      this.status.operationId !== operationId ||
      this.status.phase !== "pending"
    )
      return this.getStatus();
    this.clearTimer();
    this.publish({
      phase: "cancelled",
      dueAt: null,
      remainingSeconds: 0,
      message,
    });
    return this.getStatus();
  }

  cancelPending(message: string) {
    if (this.status.operationId) this.cancel(this.status.operationId, message);
  }

  shutdown() {
    this.clearTimer();
  }
}
