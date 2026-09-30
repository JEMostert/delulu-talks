import { personalize, ruleKind, splitForRewrite } from "./personalization";
import type { CustomWord, DictationFormatting } from "./types";

const commands: Record<string, Record<string, string>> = {
  en: {
    "insert comma": ",",
    "insert period": ".",
    "insert question mark": "?",
    "insert exclamation mark": "!",
    "insert colon": ":",
    "insert semicolon": ";",
    "insert new line": "\n",
    "insert new paragraph": "\n\n",
  },
  nl: {
    "voeg komma in": ",",
    "voeg punt in": ".",
    "voeg vraagteken in": "?",
    "voeg uitroepteken in": "!",
    "voeg dubbele punt in": ":",
    "voeg puntkomma in": ";",
    "voeg nieuwe regel in": "\n",
    "voeg nieuwe alinea in": "\n\n",
  },
};

const wordCharacter = /[\p{L}\p{M}\p{N}_]/u;

function escaped(text: string, index: number): boolean {
  let slashes = 0;
  while (index > 0 && text[--index] === "\\") slashes += 1;
  return slashes % 2 === 1;
}

/** Protect only balanced literal delimiters; apostrophes inside words stay prose. */
function literals(text: string): Array<{ text: string; protected: boolean }> {
  const parts: Array<{ text: string; protected: boolean }> = [];
  let cursor = 0;
  for (let index = 0; index < text.length; index += 1) {
    const opener = text[index];
    if (escaped(text, index) || !["`", '"', "'", "“", "‘"].includes(opener))
      continue;
    if (
      (opener === "'" || opener === "‘") &&
      wordCharacter.test(text[index - 1] ?? "")
    )
      continue;
    let delimiter = opener;
    if (opener === "`") {
      while (text[index + delimiter.length] === "`") delimiter += "`";
    }
    const closer = opener === "“" ? "”" : opener === "‘" ? "’" : delimiter;
    let end = text.indexOf(closer, index + delimiter.length);
    while (
      end >= 0 &&
      (escaped(text, end) ||
        ((closer === "'" || closer === "’") &&
          wordCharacter.test(text[end - 1] ?? "") &&
          wordCharacter.test(text[end + 1] ?? "")) ||
        (opener === "`" &&
          (text[end - 1] === "`" || text[end + closer.length] === "`")))
    ) {
      end = text.indexOf(closer, end + closer.length);
    }
    if (end < 0) {
      if (opener === "`") index += delimiter.length - 1;
      continue;
    }
    if (index > cursor)
      parts.push({ text: text.slice(cursor, index), protected: false });
    end += closer.length;
    parts.push({ text: text.slice(index, end), protected: true });
    cursor = end;
    index = end - 1;
  }
  if (cursor < text.length)
    parts.push({ text: text.slice(cursor), protected: false });
  return parts;
}

function spokenCommands(text: string, language: string): string {
  const replacements = commands[language];
  const phrases = Object.keys(replacements).sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    `[ \\t]*(?<![\\p{L}\\p{M}\\p{N}_])(?<![\\p{L}\\p{M}\\p{N}_]['’])(${phrases.join("|")})(?![\\p{L}\\p{M}\\p{N}_])(?!['’][\\p{L}\\p{M}\\p{N}_])[ \\t]*`,
    "giu",
  );
  return text.replace(
    pattern,
    (match: string, phrase: string, offset: number) => {
      const inserted = replacements[phrase.toLowerCase()];
      if (inserted.startsWith("\n")) return inserted;
      const following = text[offset + match.length];
      const hadSpace = /[ \t]$/.test(match);
      return (
        inserted +
        (hadSpace && following && !/[\s.,!?;:)}\]"'”’]/u.test(following)
          ? " "
          : "")
      );
    },
  );
}

export function formatDictation(
  text: string,
  words: CustomWord[],
  mode: DictationFormatting,
  language: string,
): string {
  if (mode !== "spoken" || (language !== "en" && language !== "nl"))
    return personalize(text, words);
  const corrections = words.filter((word) => ruleKind(word) === "correction");
  return literals(text)
    .map((literal) => {
      if (literal.protected) return literal.text;
      return splitForRewrite(literal.text, words)
        .map((part) =>
          part.protected
            ? part.text
            : spokenCommands(personalize(part.text, corrections), language),
        )
        .join("");
    })
    .join("");
}
