import { randomUUID } from "node:crypto";
import type { HistoryDeletionState } from "../../src/types";

export function historySelection(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 500)
    throw new Error("Select between 1 and 500 transcripts.");
  const ids = value.map((id) => {
    if (typeof id !== "string" || !id.length || id.length > 128)
      throw new Error("Invalid selected transcript.");
    return id;
  });
  if (new Set(ids).size !== ids.length)
    throw new Error("Each transcript must be selected only once.");
  return ids;
}

// Stage visibility only. Originals remain in their existing store until expiry;
// quitting/crashing during the window cancels deletion of durable records.
export class HistoryBatchDeletion {
  private state: HistoryDeletionState | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly commit: (ids: readonly string[]) => void,
    private readonly changed: () => void,
  ) {}

  getState(): HistoryDeletionState | null {
    return this.state ? structuredClone(this.state) : null;
  }

  hidden(id: string): boolean {
    return this.state?.phase === "pending" && this.state.ids.includes(id);
  }

  assertNoPending(): void {
    if (this.state?.phase === "pending")
      throw new Error(
        "Undo the pending deletion or wait for its window to finish first.",
      );
  }

  stage(ids: string[]): HistoryDeletionState {
    this.assertNoPending();
    this.state = {
      token: randomUUID(),
      ids: [...ids],
      phase: "pending",
      deadline: Date.now() + 30_000,
    };
    const token = this.state.token;
    this.timer = setTimeout(() => this.finish(token), 30_000);
    this.timer.unref();
    this.changed();
    return this.getState()!;
  }

  undo(token: string): void {
    if (this.state?.token !== token || this.state.phase !== "pending")
      throw new Error("This deletion can no longer be undone.");
    if (Date.now() >= this.state.deadline) {
      this.finish(token);
      throw new Error("The undo window has finished.");
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.state = null;
    this.changed();
  }

  private finish(token: string): void {
    const pending = this.state;
    if (!pending || pending.token !== token || pending.phase !== "pending")
      return;
    this.timer = null;
    try {
      this.commit(pending.ids);
      this.state = null;
    } catch (error) {
      this.state = {
        ...pending,
        phase: "failed",
        error:
          `Deletion was not completed. ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            600,
          ),
      };
    }
    this.changed();
  }
}
