/** Backend-reported metadata is separate from a requested decoder hint. */
export function normalizeReportedLanguage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toLowerCase();
  if (
    !code ||
    code === "und" ||
    code === "unknown" ||
    code === "mixed" ||
    code.length > 32 ||
    !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(code)
  )
    return null;
  return code;
}

export type NormalizedLanguageMetadata = {
  recognizedLanguage: string | null;
  recognizedLanguages: string[];
  languageStatus: "reported" | "mixed" | "unknown";
};

export function normalizeLanguageMetadata(
  value: unknown,
): NormalizedLanguageMetadata {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const single = normalizeReportedLanguage(source.recognizedLanguage);
  const raw = Array.isArray(source.recognizedLanguages)
    ? source.recognizedLanguages
    : single
      ? [single]
      : [];
  const normalized = raw.slice(0, 128).map(normalizeReportedLanguage);
  const languages = [
    ...new Set(normalized.filter((code): code is string => code !== null)),
  ];
  if (
    source.languageStatus === "unknown" ||
    raw.length > 128 ||
    normalized.some((code) => code === null)
  ) {
    return {
      recognizedLanguage: null,
      recognizedLanguages: languages,
      languageStatus: "unknown",
    };
  }
  if (languages.length > 1) {
    return {
      recognizedLanguage: null,
      recognizedLanguages: languages,
      languageStatus: "mixed",
    };
  }
  if (
    languages.length === 1 &&
    source.languageStatus !== "mixed" &&
    (source.languageStatus === "reported" || single === languages[0])
  ) {
    return {
      recognizedLanguage: languages[0],
      recognizedLanguages: languages,
      languageStatus: "reported",
    };
  }
  return {
    recognizedLanguage: null,
    recognizedLanguages: languages,
    languageStatus: "unknown",
  };
}

// Frequent words unique to one of the languages with spoken formatting. Words
// both languages use, such as "is", "in", "was" and "of", are left out.
const FUNCTION_WORDS = {
  nl: new Set(
    "de het een en ik je jij ze zij hij niet ook maar dat die dit deze van voor met naar op heb hebben heeft ben bent zijn wordt worden kan kunnen moet wil gaan ga gaat nog wel dan toen omdat als bij uit om tot wat hoe waar wie hier daar nu morgen vandaag daarna echt mijn jouw onze hun mij zo heel veel geen iets alles".split(
      " ",
    ),
  ),
  en: new Set(
    "the a an and i you they he she it not also but that this these those for with to on have has am are were be been will would can could should must going go goes still already then because if at from what how where who there here now tomorrow today my your our their so very much no some all his her really just".split(
      " ",
    ),
  ),
};

/**
 * Guess Dutch or English from frequent words, for text whose language the
 * speech model did not report: R2T2 reports none for Dutch speech full of
 * English terms. Returns null unless one language clearly dominates.
 */
export function guessTextLanguage(text: string): "nl" | "en" | null {
  const counts = { nl: 0, en: 0 };
  for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
    if (FUNCTION_WORDS.nl.has(word)) counts.nl++;
    if (FUNCTION_WORDS.en.has(word)) counts.en++;
  }
  if (counts.nl >= 2 && counts.nl >= 2 * counts.en) return "nl";
  if (counts.en >= 2 && counts.en >= 2 * counts.nl) return "en";
  return null;
}
