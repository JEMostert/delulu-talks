const commands: Record<string, readonly (readonly [string, string])[]> = {
  en: [
    ["command new paragraph", "\n\n"],
    ["command new line", "\n"],
  ],
  nl: [
    ["commando nieuwe alinea", "\n\n"],
    ["commando nieuwe regel", "\n"],
  ],
};
const wordCharacter = "[\\p{L}\\p{M}\\p{N}_]";
const quotation = /["'“”‘’]/u;

/** Explicit delivery formatting; caller retains the original recognition text. */
export function formatSpokenCommands(text: string, language: string): string {
  const grammar = commands[language.toLowerCase()];
  if (!grammar) return text;
  const replacements = new Map(grammar);
  const phrases = grammar.map(([phrase]) => phrase).join("|");
  const pattern = new RegExp(
    `(?<!${wordCharacter})(?:${phrases})(?!${wordCharacter})`,
    "giu",
  );
  let cursor = 0;
  let output = "";
  for (const match of text.matchAll(pattern)) {
    const end = match.index + match[0].length;
    // Quoted command names are ordinary text, for example documentation.
    if (
      quotation.test(text[match.index - 1] ?? "") ||
      quotation.test(text[end] ?? "")
    )
      continue;
    const replacement = replacements.get(match[0].toLowerCase());
    if (replacement === undefined) continue;
    output += text.slice(cursor, match.index).replace(/[ \t]+$/u, "");
    output += replacement;
    cursor = end;
    // Punctuation attached to the command and its separating spaces belong to
    // the command, while punctuation in the preceding prose stays untouched.
    if (/[,.!?;:]/u.test(text[cursor] ?? "")) cursor += 1;
    while (/[ \t]/u.test(text[cursor] ?? "")) cursor += 1;
  }
  return output + text.slice(cursor);
}
