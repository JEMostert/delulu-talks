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
      if (generation === this.generation) this.value = { repository, ...result };
      return this.get();
    } finally {
      this.scanning = false;
    }
  }

  async refresh(): Promise<ProjectVocabularySnapshot> {
    if (!this.value.repository) throw new Error("Select a repository first.");
    return this.select(this.value.repository);
  }
}
