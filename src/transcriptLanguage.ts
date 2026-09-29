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
