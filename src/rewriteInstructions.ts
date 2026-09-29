/** Same UTF-16 length unit as HTML maxLength and the worker protocol. */
export const MAX_REWRITE_INSTRUCTIONS = 4_000;

/** Instructions belong to one request; never normalize them into settings. */
export function validateRewriteInstructions(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string")
    throw new Error("Rewrite instructions must be text.");
  if (value.length > MAX_REWRITE_INSTRUCTIONS)
    throw new Error("Rewrite instructions are limited to 4,000 characters.");
  return value;
}
