import { AUTO_LANGUAGE, LANGUAGES } from "./data";
import type { SpeechModelId, SpeechTier } from "./types";

export type SpeechLanguageCapability = {
  readonly canSelectLanguage: boolean;
  readonly canRequestAutomaticLanguage: boolean;
  readonly backends: readonly SpeechBackendLanguageCapability[];
  readonly languages: readonly (readonly [code: string, label: string])[];
};

export type SpeechBackendLanguageCapability = {
  readonly backend: "mlx" | "cuda-vllm" | "cuda-transformers" | "onnx-cpu";
  readonly hintCodes: readonly string[];
  readonly automaticLanguage: boolean;
};

// Adapter input contract, not a measured recognition-quality guarantee. Keep
// this list aligned with Python LANGUAGE_NAMES, rather than exposing new UI
// languages automatically when the general language catalog grows.
const hintCodes = Object.freeze([
  "en",
  "de",
  "nl",
  "fr",
  "es",
  "pt",
  "it",
  "pl",
  "cs",
  "el",
  "sv",
  "da",
  "fi",
  "no",
  "uk",
  "ru",
  "tr",
  "ar",
  "he",
  "hi",
  "zh",
  "ja",
  "ko",
  "vi",
]);

export const speechBackendLanguageCapabilities = Object.freeze({
  mlx: Object.freeze({ backend: "mlx", hintCodes, automaticLanguage: false }),
  "cuda-vllm": Object.freeze({
    backend: "cuda-vllm",
    hintCodes,
    automaticLanguage: true,
  }),
  // The Transformers R2T2 processor detects the language when none is forced.
  "cuda-transformers": Object.freeze({
    backend: "cuda-transformers",
    hintCodes,
    automaticLanguage: true,
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

// Canary takes one of four forced languages. Parakeet runs its English model
// for English and its multilingual model, which detects the language, for Automatic.
const cpuLanguageCapabilities = {
  small: controlsFor([
    {
      backend: "onnx-cpu",
      hintCodes: ["en", "de", "fr", "es"],
      automaticLanguage: false,
    },
  ]),
  medium: controlsFor([
    { backend: "onnx-cpu", hintCodes: ["en"], automaticLanguage: true },
  ]),
} as const;

export function speechLanguageCapability(
  tier: SpeechTier,
  model: SpeechModelId,
) {
  return tier === "large"
    ? languageCapabilities[model]
    : cpuLanguageCapabilities[tier];
}

/** Keep a saved language the selected model accepts, or its closest default. */
export function supportedSpeechLanguage(
  tier: SpeechTier,
  model: SpeechModelId,
  language: string,
): string {
  const capability = speechLanguageCapability(tier, model);
  if (language === AUTO_LANGUAGE)
    return capability.canRequestAutomaticLanguage ? language : "en";
  if (capability.languages.some(([code]) => code === language)) return language;
  return tier === "medium" ? AUTO_LANGUAGE : "en";
}

/** One sentence explaining how the selected model uses the language setting. */
export function speechLanguageHelp(tier: SpeechTier, language: string): string {
  if (tier === "small")
    return "Canary transcribes the language you choose: English, German, French or Spanish.";
  if (tier === "medium")
    return language === AUTO_LANGUAGE
      ? "Parakeet's multilingual model detects the language: 25 European languages, including Dutch and English."
      : "English uses Parakeet's English model. Choose Automatic detection for 25 other European languages.";
  return language === AUTO_LANGUAGE
    ? "R2T2 detects the language, also when you switch between languages. Choose one to force it."
    : "Forces the speech model to this language. Automatic detection handles mixed languages.";
}
