import { randomUUID } from "node:crypto";
import type {
  RuntimeSetupKind,
  RuntimeSetupLog,
  RuntimeSetupLogEntry,
} from "../../src/types";

export const MAX_SETUP_LOG_ENTRIES = 128;
export const MAX_SETUP_LOG_CHARACTERS = 64_000;
export const MAX_SETUP_LOG_ENTRY_CHARACTERS = 4_096;

type SetupEvent = Omit<RuntimeSetupLogEntry, "at">;
type FinalOutcome = "success" | "error" | "cancelled";

export class SetupLog {
  private attemptId: string | null = null;
  private kind: RuntimeSetupKind | null = null;
  private startedAt: number | null = null;
  private finishedAt: number | null = null;
  private outcome: RuntimeSetupLog["outcome"] = "idle";
  private entries: RuntimeSetupLogEntry[] = [];
  private characters = 2;
  private truncated = false;

  get activeId(): string | null {
    return this.outcome === "running" ? this.attemptId : null;
  }

  begin(kind: RuntimeSetupKind): string {
    this.attemptId = randomUUID();
    this.kind = kind;
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.outcome = "running";
    this.entries = [];
    this.characters = 2;
    this.truncated = false;
    return this.attemptId;
  }

  record(attemptId: string | null, event: SetupEvent): void {
    if (!attemptId || attemptId !== this.activeId) return;
    const entry = this.sanitize(event);
    this.entries.push(entry);
    this.characters +=
      JSON.stringify(entry).length + (this.entries.length > 1 ? 1 : 0);
    while (
      this.entries.length > MAX_SETUP_LOG_ENTRIES ||
      this.characters > MAX_SETUP_LOG_CHARACTERS
    ) {
      const outputIndex = this.entries.findIndex(
        (item) => item.type === "stdout" || item.type === "stderr",
      );
      const [removed] = this.entries.splice(
        outputIndex === -1 ? 0 : outputIndex,
        1,
      );
      this.characters -=
        JSON.stringify(removed).length + (this.entries.length > 0 ? 1 : 0);
      this.truncated = true;
    }
  }

  finish(
    attemptId: string | null,
    outcome: FinalOutcome,
    message?: string,
  ): void {
    if (!attemptId || attemptId !== this.activeId) return;
    this.record(attemptId, {
      type: outcome === "error" ? "error" : "stage",
      stage: "finished",
      message: message ?? `Setup ${outcome}`,
    });
    this.finishedAt = Date.now();
    this.outcome = outcome;
  }

  snapshot(kind: RuntimeSetupKind): RuntimeSetupLog {
    const matches = this.kind === kind;
    return {
      kind,
      attemptId: matches ? this.attemptId : null,
      startedAt: matches ? this.startedAt : null,
      finishedAt: matches ? this.finishedAt : null,
      outcome: matches ? this.outcome : "idle",
      entries: matches
        ? this.entries.map((entry) => ({
            ...entry,
            ...(entry.command
              ? {
                  command: {
                    program: entry.command.program,
                    args: [...entry.command.args],
                  },
                }
              : {}),
          }))
        : [],
      truncated: matches && this.truncated,
      maxEntries: MAX_SETUP_LOG_ENTRIES,
      maxCharacters: MAX_SETUP_LOG_CHARACTERS,
    };
  }

  private sanitize(event: SetupEvent): RuntimeSetupLogEntry {
    const bounded = (value: string, limit: number): string => {
      if (value.length > limit) this.truncated = true;
      return value.slice(0, limit);
    };
    const entry: RuntimeSetupLogEntry = {
      at: Date.now(),
      type: event.type,
      stage: bounded(event.stage, 128),
      message: bounded(event.message, MAX_SETUP_LOG_ENTRY_CHARACTERS),
    };
    if (event.command) {
      if (event.command.args.length > 64) this.truncated = true;
      entry.command = {
        program: bounded(event.command.program, 256),
        args: event.command.args.slice(0, 64).map((arg) => bounded(arg, 128)),
      };
    }
    if (event.durationMs !== undefined && Number.isFinite(event.durationMs))
      entry.durationMs = event.durationMs;
    if (
      event.exitCode === null ||
      (typeof event.exitCode === "number" && Number.isFinite(event.exitCode))
    )
      entry.exitCode = event.exitCode;
    if (event.signal !== undefined)
      entry.signal = event.signal === null ? null : bounded(event.signal, 64);

    // Bound the serialized copy too: escaped output and command arguments count.
    while (
      entry.command?.args.length &&
      JSON.stringify(entry).length > MAX_SETUP_LOG_ENTRY_CHARACTERS
    ) {
      entry.command.args.pop();
      this.truncated = true;
    }
    if (JSON.stringify(entry).length > MAX_SETUP_LOG_ENTRY_CHARACTERS) {
      const message = entry.message;
      let lower = 0;
      let upper = message.length;
      while (lower < upper) {
        const length = Math.ceil((lower + upper) / 2);
        entry.message = message.slice(0, length);
        if (JSON.stringify(entry).length <= MAX_SETUP_LOG_ENTRY_CHARACTERS)
          lower = length;
        else upper = length - 1;
      }
      entry.message = message.slice(0, lower);
      this.truncated = true;
    }
    return entry;
  }
}
