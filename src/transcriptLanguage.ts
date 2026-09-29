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
