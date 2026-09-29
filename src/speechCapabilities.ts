import { LANGUAGES } from "./data";
import type { SpeechModelId } from "./types";

export type SpeechLanguageCapability = {
  readonly canSelectLanguage: boolean;
  readonly canRequestAutomaticLanguage: boolean;
  readonly backends: readonly SpeechBackendLanguageCapability[];
  readonly languages: readonly (readonly [code: string, label: string])[];
};

export type SpeechBackendLanguageCapability = {
  readonly backend: "mlx" | "cuda-vllm" | "cuda-transformers";
  readonly hintCodes: readonly string[];
  readonly automaticLanguage: false;
};

// Adapter input contract, not a measured recognition-quality guarantee. Keep
// this list aligned with Python LANGUAGE_NAMES, rather than exposing new UI
// languages automatically when the general language catalog grows.
const hintCodes = Object.freeze([
  "en", "de", "nl", "fr", "es", "pt", "it", "pl", "cs", "el", "sv", "da",
  "fi", "no", "uk", "ru", "tr", "ar", "he", "hi", "zh", "ja", "ko", "vi",
]);

export const speechBackendLanguageCapabilities = Object.freeze({
  mlx: Object.freeze({ backend: "mlx", hintCodes, automaticLanguage: false }),
  "cuda-vllm": Object.freeze({
    backend: "cuda-vllm", hintCodes, automaticLanguage: false,
  }),
  "cuda-transformers": Object.freeze({
    backend: "cuda-transformers", hintCodes, automaticLanguage: false,
  }),
} satisfies Record<string, SpeechBackendLanguageCapability>);

function controlsFor(
  backends: readonly SpeechBackendLanguageCapability[],
): SpeechLanguageCapability {
  const languages = LANGUAGES.filter(([code]) =>
    backends.every((backend) => backend.hintCodes.includes(code)),
  );
  return Object.freeze({
    canSelectLanguage: languages.length > 0,
    canRequestAutomaticLanguage: backends.every(
      (backend) => backend.automaticLanguage,
    ),
    backends,
    languages,
  });
}

const languageCapabilities: Record<SpeechModelId, SpeechLanguageCapability> = {
  r2t2: controlsFor([
    speechBackendLanguageCapabilities["cuda-vllm"],
    speechBackendLanguageCapabilities["cuda-transformers"],
  ]),
  r2t2Mlx: controlsFor([speechBackendLanguageCapabilities.mlx]),
};

export function speechLanguageCapability(model: SpeechModelId) {
  return languageCapabilities[model];
}
