export type ProjectVocabularySnapshot = {
  repository: string | null;
  symbols: string[];
  filesScanned: number;
  truncated: boolean;
  warnings: string[];
};

export function emptyProjectVocabulary(): ProjectVocabularySnapshot {
  return { repository: null, symbols: [], filesScanned: 0, truncated: false, warnings: [] };
}
