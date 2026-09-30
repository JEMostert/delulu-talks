import { randomUUID } from "node:crypto";
import {
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { RuleUsage } from "../../src/types";

/** Aggregate match counts only: never store text, event times or transcript IDs. */
export class RuleUsageService {
  private readonly path: string;
  private counts: Record<string, number> = Object.create(null);
  private error: string | null = null;
  private corrupt = false;
  private missed = false;

  constructor(dataDirectory: string) {
    this.path = join(dataDirectory, "rule-usage.json");
    try {
      if (statSync(this.path).size > 1024 * 1024)
        throw new Error("Oversized usage data");
      const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid usage data");
      const source = value as Record<string, unknown>;
      if (
        source.version !== 1 ||
        Object.keys(source).some(
          (key) => !["version", "counts"].includes(key),
        ) ||
        !source.counts ||
        typeof source.counts !== "object" ||
        Array.isArray(source.counts)
      )
        throw new Error("Invalid usage schema");
      const entries = Object.entries(source.counts);
      if (
        entries.length > 500 ||
        entries.some(
          ([id, count]) =>
            !id ||
            id.length > 128 ||
            typeof count !== "number" ||
            !Number.isSafeInteger(count) ||
            count < 0,
        )
      )
        throw new Error("Invalid usage counts");
      for (const [id, count] of entries) this.counts[id] = count as number;
    } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code !== "ENOENT") {
        this.corrupt = true;
        this.error =
          "Local rule counts could not be read. The existing file is preserved; reset counts explicitly to start again.";
      }
    }
  }

  get(ruleIds: string[]): RuleUsage {
    const counts: Record<string, number> = Object.create(null);
    for (const id of ruleIds.slice(0, 500)) counts[id] = this.counts[id] ?? 0;
    return { counts, error: this.error };
  }

  record(matches: Record<string, number>, currentRuleIds: string[]): void {
    if (this.corrupt || !Object.keys(matches).length) return;
    const next: Record<string, number> = Object.create(null);
    for (const id of currentRuleIds.slice(0, 500)) {
      const count = matches[id];
      const increment = Number.isSafeInteger(count) && count > 0 ? count : 0;
      next[id] = Math.min(
        Number.MAX_SAFE_INTEGER,
        (this.counts[id] ?? 0) + increment,
      );
    }
    try {
      this.write(next);
    } catch {
      // Optional statistics must never turn a usable transcript into a failure.
      this.missed = true;
      this.error =
        "Local rule counts could not be saved. Transcription is unaffected; counts may be incomplete.";
    }
  }

  reset(): void {
    this.write(Object.create(null));
    this.corrupt = false;
    this.missed = false;
    this.error = null;
  }

  private write(next: Record<string, number>): void {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        temporary,
        `${JSON.stringify({ version: 1, counts: next })}\n`,
        { mode: 0o600, flag: "wx" },
      );
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
    this.counts = next;
    this.error = this.missed
      ? "Some local rule counts were not saved earlier. Counts may be incomplete until reset."
      : null;
  }
}
