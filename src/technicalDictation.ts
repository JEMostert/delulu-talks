import { parseTechnicalIdentifier, type IdentifierStyle } from "./technicalIdentifiers";

/** Recognition-independent rendering: these modes only produce text, never actions. */
export type DictationMode = "prose" | "code" | "command";

type SymbolSpacing = "join" | "operator" | "prefix" | "layout";

export interface TechnicalDictationGuideEntry {
  label: string;
  phrases: readonly string[];
  output: string;
  spacing: SymbolSpacing;
}

/** This same grammar is exposed to the UI so help stays in sync with rendering. */
export const technicalDictationGuide: readonly TechnicalDictationGuideEntry[] = [
  { label: "Parentheses", phrases: ["open parenthesis", "open paren", "haakje openen"], output: "(", spacing: "join" },
  { label: "Close parenthesis", phrases: ["close parenthesis", "close paren", "haakje sluiten"], output: ")", spacing: "join" },
  { label: "Brackets", phrases: ["open bracket", "vierkante haak openen"], output: "[", spacing: "join" },
  { label: "Close bracket", phrases: ["close bracket", "vierkante haak sluiten"], output: "]", spacing: "join" },
  { label: "Braces", phrases: ["open brace", "accolade openen"], output: "{", spacing: "join" },
  { label: "Close brace", phrases: ["close brace", "accolade sluiten"], output: "}", spacing: "join" },
  { label: "Dot", phrases: ["dot", "period", "punt"], output: ".", spacing: "join" },
  { label: "Comma", phrases: ["comma", "komma"], output: ",", spacing: "join" },
  { label: "Colon", phrases: ["colon", "dubbele punt"], output: ":", spacing: "join" },
  { label: "Semicolon", phrases: ["semicolon", "puntkomma"], output: ";", spacing: "join" },
  { label: "Underscore", phrases: ["underscore", "laag streepje"], output: "_", spacing: "join" },
  { label: "Hyphen", phrases: ["hyphen", "dash", "koppelteken"], output: "-", spacing: "join" },
  { label: "Command option", phrases: ["double dash", "dubbel streepje"], output: "--", spacing: "prefix" },
  { label: "Slash", phrases: ["forward slash", "slash", "schuine streep"], output: "/", spacing: "join" },
  { label: "Backslash", phrases: ["backslash", "omgekeerde schuine streep"], output: "\\", spacing: "join" },
  { label: "Single quote", phrases: ["single quote", "enkel aanhalingsteken"], output: "'", spacing: "join" },
  { label: "Double quote", phrases: ["double quote", "dubbel aanhalingsteken"], output: '"', spacing: "join" },
  { label: "Backtick", phrases: ["backtick", "accent grave"], output: "`", spacing: "join" },
  { label: "Assignment", phrases: ["equals", "is gelijk aan"], output: "=", spacing: "operator" },
  { label: "Equality", phrases: ["double equals", "dubbel gelijk"], output: "==", spacing: "operator" },
  { label: "Strict equality", phrases: ["triple equals", "driedubbel gelijk"], output: "===", spacing: "operator" },
  { label: "Not equal", phrases: ["not equals", "not equal", "niet gelijk aan"], output: "!=", spacing: "operator" },
  { label: "Less than", phrases: ["less than", "kleiner dan"], output: "<", spacing: "operator" },
  { label: "Greater than", phrases: ["greater than", "groter dan"], output: ">", spacing: "operator" },
  { label: "Less than or equal", phrases: ["less than or equal", "kleiner dan of gelijk aan"], output: "<=", spacing: "operator" },
  { label: "Greater than or equal", phrases: ["greater than or equal", "groter dan of gelijk aan"], output: ">=", spacing: "operator" },
  { label: "Plus", phrases: ["plus"], output: "+", spacing: "operator" },
  { label: "Minus", phrases: ["minus", "minteken"], output: "-", spacing: "operator" },
  { label: "Multiply", phrases: ["asterisk", "times", "sterretje"], output: "*", spacing: "operator" },
  { label: "Pipe", phrases: ["pipe", "vertical bar", "verticale streep"], output: "|", spacing: "operator" },
  { label: "Logical and", phrases: ["double ampersand", "dubbele ampersand"], output: "&&", spacing: "operator" },
  { label: "Logical or", phrases: ["double pipe", "dubbele verticale streep"], output: "||", spacing: "operator" },
  { label: "Arrow", phrases: ["fat arrow", "arrow", "pijl"], output: "=>", spacing: "operator" },
  { label: "Ampersand", phrases: ["ampersand", "en teken"], output: "&", spacing: "join" },
  { label: "Dollar", phrases: ["dollar sign", "dollarteken"], output: "$", spacing: "join" },
  { label: "Hash", phrases: ["hash", "hash sign", "hekje"], output: "#", spacing: "join" },
  { label: "At sign", phrases: ["at sign", "apenstaartje"], output: "@", spacing: "join" },
  { label: "Exclamation", phrases: ["exclamation mark", "uitroepteken"], output: "!", spacing: "join" },
  { label: "Question mark", phrases: ["question mark", "vraagteken"], output: "?", spacing: "join" },
  { label: "Percent", phrases: ["percent sign", "procentteken"], output: "%", spacing: "join" },
  { label: "Space", phrases: ["space", "spatie"], output: " ", spacing: "layout" },
  { label: "Tab", phrases: ["tab", "tab character", "tabteken"], output: "\t", spacing: "layout" },
  { label: "New line", phrases: ["new line", "newline", "nieuwe regel"], output: "\n", spacing: "layout" },
];

const entries = technicalDictationGuide.flatMap((entry) =>
  entry.phrases.map((phrase) => ({ phrase, entry })),
).sort((a, b) => b.phrase.length - a.phrase.length);
const byPhrase = new Map(entries.map(({ phrase, entry }) => [phrase, entry]));
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const phrasePattern = entries.map(({ phrase }) => escapeRegex(phrase).replace(/ /g, "[ \\t]+")).join("|");
// Unicode letter/number boundaries prevent matching inside names or accented words.
const identifierStyles: Record<string, IdentifierStyle> = {
  "camel case": "camel", "pascal case": "pascal", "snake case": "snake",
  "kebab case": "kebab", "literal spelling": "literal",
};
const identifierPattern = `(camel[ \\t]+case|pascal[ \\t]+case|snake[ \\t]+case|kebab[ \\t]+case|literal[ \\t]+spelling)[ \\t]+([^\\r\\n]*?)[ \\t]+(?:end[ \\t]+identifier|einde[ \\t]+naam)`;
const tokenPattern = `(?<![\\p{L}\\p{M}\\p{N}_])(?:${identifierPattern}|(?:literal|literally|literaal)[ \\t]+([\\p{L}\\p{N}_]+(?:['’][\\p{L}\\p{N}_]+)*)|(${phrasePattern}))(?![\\p{L}\\p{M}\\p{N}_])`;

/**
 * Prose is byte-for-byte unchanged. Code and command share an explicit grammar.
 * Join symbols consume adjacent ordinary spaces; operators use one space
 * on either side; command double-dash keeps its preceding whitespace. Layout
 * tokens replace adjacent ordinary spaces with exactly one space, tab, or newline.
 * Existing newlines/tabs and all unmatched Unicode/punctuation are preserved.
 * Say "literal <word>" (Dutch: "literaal") to emit the next word unchanged.
 */
export function renderTechnicalDictation(text: string, mode: DictationMode): string {
  if (mode === "prose") return text;
  const matcher = new RegExp(tokenPattern, "giu");
  type Chunk = { text: string; entry?: TechnicalDictationGuideEntry };
  const chunks: Chunk[] = [];
  let cursor = 0;
  for (const match of text.matchAll(matcher)) {
    const index = match.index;
    chunks.push({ text: text.slice(cursor, index) });
    if (match[1] !== undefined) {
      const style = identifierStyles[match[1].toLowerCase().replace(/[ \t]+/g, " ")];
      // Render as a literal chunk: identifiers named "dot" or "space" must
      // never be fed back into the symbol grammar. Invalid commands stay exact.
      chunks.push({ text: parseTechnicalIdentifier(match[2], style) ?? match[0] });
    } else {
      chunks.push(match[3] !== undefined
        ? { text: match[3] }
        : { text: "", entry: byPhrase.get(match[4].toLowerCase().replace(/[ \t]+/g, " ")) });
    }
    cursor = index + match[0].length;
  }
  chunks.push({ text: text.slice(cursor) });

  let rendered = "";
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk.entry) {
      rendered += chunk.text;
      continue;
    }
    const { output, spacing } = chunk.entry;
    // Only regular spaces are consumed here: existing tabs remain indentation.
    if (spacing !== "prefix") rendered = rendered.replace(/ +$/, "");
    const next = chunks[index + 1];
    if (next) next.text = next.text.replace(/^ +/, "");
    if (spacing === "operator") {
      const before = rendered && !/[\s]$/.test(rendered) ? " " : "";
      const following = chunks.slice(index + 1).find((item) => item.entry || item.text);
      const after = following && (following.entry || !/^\s/.test(following.text)) ? " " : "";
      rendered += before + output + after;
    } else {
      rendered += output;
    }
  }
  return rendered;
}
