export type TechnicalAddressKind =
  "path" | "url" | "email" | "version" | "extension";

export interface TechnicalAddressResult {
  text: string;
  warnings: string[];
}

export const technicalAddressGuide: Record<
  TechnicalAddressKind,
  {
    label: string;
    spoken: string;
    result: string;
  }
> = {
  path: {
    label: "Path",
    spoken: "src slash App dot tsx",
    result: "src/App.tsx",
  },
  url: {
    label: "URL",
    spoken: "https colon slash slash example dot com slash Docs",
    result: "https://example.com/Docs",
  },
  email: {
    label: "Email",
    spoken: "Ada dot Lovelace at example dot com",
    result: "Ada.Lovelace@example.com",
  },
  version: {
    label: "Version",
    spoken: "one dot two dot zero",
    result: "1.2.0",
  },
  extension: {
    label: "Extension",
    spoken: "dot tar dot gz",
    result: ".tar.gz",
  },
};

export const technicalAddressGrammar = [
  { phrases: ["dot", "period", "punt"], output: "." },
  { phrases: ["forward slash", "slash", "schuine streep"], output: "/" },
  {
    phrases: ["backslash", "back slash", "omgekeerde schuine streep"],
    output: "\\",
  },
  { phrases: ["at sign", "at", "apenstaartje"], output: "@" },
  { phrases: ["hyphen", "dash", "koppelteken", "streepje"], output: "-" },
  { phrases: ["underscore", "laag streepje"], output: "_" },
  { phrases: ["colon", "dubbele punt"], output: ":" },
  { phrases: ["space", "spatie"], output: " " },
] as const;

const digits: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  nul: "0",
  een: "1",
  één: "1",
  twee: "2",
  drie: "3",
  vier: "4",
  vijf: "5",
  zes: "6",
  zeven: "7",
  acht: "8",
  negen: "9",
};
const separators = new Map<string, string>(
  technicalAddressGrammar.flatMap((entry) =>
    entry.phrases.map((phrase) => [phrase, entry.output] as [string, string]),
  ),
);
const escapeRegex = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alternatives = [...separators.keys(), ...Object.keys(digits)]
  .sort((a, b) => b.length - a.length)
  .map((phrase) => escapeRegex(phrase).replace(/ /g, "[ \\t]+"))
  .join("|");
const tokenPattern = `(?<![\\p{L}\\p{N}_])(?:(?:literal|literally|literaal)[ \\t]+([\\p{L}\\p{N}_]+)|(${alternatives}))(?![\\p{L}\\p{N}_])`;

/**
 * Explicit, advisory conversion. Never infers missing separators, fixes casing,
 * joins unknown words, or executes/opens a candidate. Literal/literaal escapes
 * the next word. Number words map only zero through nine (English and Dutch).
 */
export function parseTechnicalAddress(
  text: string,
  kind: TechnicalAddressKind,
): TechnicalAddressResult {
  if (text.length > 20_000) {
    return {
      text,
      warnings: [
        "Input exceeds 20,000 characters. Original text was preserved; select a shorter address to parse.",
      ],
    };
  }
  const warnings = new Set<string>();
  type Piece = { text: string; separator?: boolean };
  const pieces: Piece[] = [];
  let cursor = 0;
  const addUnparsed = (value: string) => {
    pieces.push({ text: value });
    const content = value.trim();
    if (/\S\s+\S/u.test(content)) {
      warnings.add(
        `Ambiguous words kept unchanged: “${content}”. Say separators explicitly or edit the preview.`,
      );
    }
  };
  for (const match of text.matchAll(new RegExp(tokenPattern, "giu"))) {
    addUnparsed(text.slice(cursor, match.index));
    if (match[1] !== undefined) {
      pieces.push({ text: match[1] });
    } else {
      const phrase = match[2].toLowerCase().replace(/[ \t]+/g, " ");
      const separator = separators.get(phrase);
      if (separator !== undefined) {
        pieces.push({ text: separator, separator: true });
      } else {
        pieces.push({ text: digits[phrase] });
      }
    }
    cursor = match.index + match[0].length;
  }
  addUnparsed(text.slice(cursor));
  // Remove only ordinary spaces adjacent to an explicit separator. Tabs and
  // line breaks remain visible as ambiguous input instead of silently joining.
  for (let index = 0; index < pieces.length; index += 1) {
    if (!pieces[index].separator) continue;
    const before = pieces[index - 1];
    const after = pieces[index + 1];
    if (before) before.text = before.text.replace(/ +$/, "");
    if (after) after.text = after.text.replace(/^ +/, "");
  }
  const candidate = pieces.map((piece) => piece.text).join("");
  if (!candidate.trim()) warnings.add("The candidate is empty.");
  if (/\s/u.test(candidate)) {
    warnings.add(
      kind === "path"
        ? "This path contains whitespace. Spaces are preserved; check each segment before applying."
        : "The candidate contains whitespace. Unseparated words or digit sequences remain ambiguous; edit the preview.",
    );
  }

  if (kind === "url") {
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)) {
      warnings.add(
        "URL protocol is missing or incomplete. Say https colon slash slash explicitly.",
      );
    }
    const authority = candidate.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1];
    if (!authority)
      warnings.add("URL host/domain is missing or could not be identified.");
    else if (/\s/u.test(authority))
      warnings.add("URL host contains whitespace.");
  } else if (kind === "email") {
    const parts = candidate.split("@");
    if (parts.length !== 2)
      warnings.add("Email requires exactly one at sign (@).");
    if (!parts[0]) warnings.add("Email name before @ is missing.");
    if (
      parts.length === 2 &&
      (!parts[1] || !/^[^\s@.]+(?:\.[^\s@.]+)+$/u.test(parts[1]))
    ) {
      warnings.add(
        "Email domain is missing or incomplete; say its dots explicitly.",
      );
    }
  } else if (kind === "version") {
    if (!/^v?\d+(?:\.\d+)*$/i.test(candidate)) {
      warnings.add(
        "Version is not a plain digit/dot sequence with an optional v prefix. Prerelease labels and other pieces require confirmation.",
      );
    }
  } else if (kind === "extension") {
    if (!/^\.[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*$/u.test(candidate)) {
      warnings.add(
        "Extension should start with an explicit dot and contain extension segments only.",
      );
    }
  }
  return { text: candidate, warnings: [...warnings] };
}
