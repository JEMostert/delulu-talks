export type IdentifierReplacement = {
  id: string;
  createdAt: number;
  repository: string;
  rawSpeech: string;
  symbol: string;
};

export type ProjectVocabularySnapshot = {
  repository: string | null;
  symbols: string[];
  filesScanned: number;
  truncated: boolean;
  warnings: string[];
  choices: IdentifierReplacement[];
};

export function emptyProjectVocabulary(): ProjectVocabularySnapshot {
  return {
    repository: null,
    symbols: [],
    filesScanned: 0,
    truncated: false,
    warnings: [],
    choices: [],
  };
}
