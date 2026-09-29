import { LANGUAGES } from "./data";
import type { SpeechModelId } from "./types";

export type SpeechLanguageCapability = {
  readonly canSelectLanguage: boolean;
  readonly languages: readonly (readonly [code: string, label: string])[];
};

// Home and Settings previously read LANGUAGES directly. Both active R2T2
// runtimes offer the same explicit selection; historical Qwen is not active.
const explicitR2t2Language: SpeechLanguageCapability = Object.freeze({
  canSelectLanguage: true,
  languages: LANGUAGES,
});

const languageCapabilities: Record<SpeechModelId, SpeechLanguageCapability> = {
  r2t2: explicitR2t2Language,
  r2t2Mlx: explicitR2t2Language,
};

export function speechLanguageCapability(model: SpeechModelId) {
  return languageCapabilities[model];
}
