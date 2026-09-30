import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { emptyProjectVocabulary, type ProjectVocabularySnapshot } from "../../src/projectVocabulary";
import { extractProjectSymbols } from "./projectVocabulary";

/** An explicitly selected, session-only scope. Source bodies never enter this store. */
export class ProjectVocabularyScope {
  private value = emptyProjectVocabulary();
  private generation = 0;
  private scanning = false;

  get(): ProjectVocabularySnapshot {
    return structuredClone(this.value);
  }

  clear(): ProjectVocabularySnapshot {
    this.generation += 1;
    this.value = emptyProjectVocabulary();
    return this.get();
  }

  async select(path: string): Promise<ProjectVocabularySnapshot> {
    if (this.scanning) throw new Error("Wait for the current repository scan to finish.");
    const generation = ++this.generation;
    this.scanning = true;
    try {
      const repository = await realpath(path);
      const result = await extractProjectSymbols(repository);
      if (generation === this.generation) this.value = { repository, ...result, choices: [] };
      return this.get();
    } finally {
      this.scanning = false;
    }
  }

  choose(input: unknown): ProjectVocabularySnapshot {
    if (this.scanning) throw new Error("Wait for the repository scan to finish.");
    if (!input || typeof input !== "object") throw new Error("Invalid identifier choice.");
    const { repository, rawSpeech, symbol } = input as Record<string, unknown>;
    if (!this.value.repository || repository !== this.value.repository)
      throw new Error("Repository scope changed. Choose a candidate from the current scope.");
    if (typeof rawSpeech !== "string" || !rawSpeech.trim() || rawSpeech.length > 256 ||
      typeof symbol !== "string" || !this.value.symbols.includes(symbol))
      throw new Error("Choose a symbol from the current repository for a nonempty phrase of at most 256 characters.");
    this.value.choices = [{ id: randomUUID(), createdAt: Date.now(), repository: this.value.repository, rawSpeech, symbol }, ...this.value.choices].slice(0, 50);
    return this.get();
  }

  async refresh(): Promise<ProjectVocabularySnapshot> {
    if (!this.value.repository) throw new Error("Select a repository first.");
    return this.select(this.value.repository);
  }
}
