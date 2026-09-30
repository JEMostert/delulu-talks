import type { MagicRewriteContext } from "./types";

/** Validate opt-in context without truncating or altering selected source text. */
export function normalizeRewriteContext(
  value: unknown,
): MagicRewriteContext | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Rewrite context must be an object");
  }
  const source = value as Record<string, unknown>;
  const limits = { language: 80, fileType: 80, selection: 4000 } as const;
  if (
    Object.keys(source).some(
      (key) => !Object.prototype.hasOwnProperty.call(limits, key),
    )
  ) {
    throw new Error("Rewrite context contains an unknown field");
  }
  const result: MagicRewriteContext = {};
  for (const key of ["language", "fileType", "selection"] as const) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const field = source[key];
    if (typeof field !== "string") {
      throw new Error(`Rewrite context ${key} must be a string`);
    }
    if (field.length > limits[key]) {
      throw new Error(
        `Rewrite context ${key} exceeds ${limits[key]} characters`,
      );
    }
    const normalized = key === "selection" ? field : field.trim();
    if (normalized.length) result[key] = normalized;
  }
  return Object.keys(result).length ? result : undefined;
}

/**
 * Partition text without changing any character or line ending. Fenced blocks and
 * contiguous four-space/tab-indented code are protected, including unterminated
 * fences and trailing blank lines after indented code. No source is interpreted.
 */
export function splitTechnicalBlocks(
  text: string,
): { text: string; protected: boolean }[] {
  const blocks: { text: string; protected: boolean }[] = [];
  let fenceCharacter: "`" | "~" | undefined;
  let fenceLength = 0;
  let indented = false;
  let offset = 0;
  let blockStart = 0;
  let blockProtected: boolean | undefined;

  while (offset < text.length) {
    const lineStart = offset;
    while (
      offset < text.length &&
      text[offset] !== "\r" &&
      text[offset] !== "\n"
    )
      offset += 1;
    const line = text.slice(lineStart, offset);
    if (text[offset] === "\r") {
      offset += 1;
      if (text[offset] === "\n") offset += 1;
    } else if (text[offset] === "\n") {
      offset += 1;
    }

    let isProtected = false;
    if (fenceCharacter !== undefined) {
      isProtected = true;
      // Count a closing fence directly; no regex grows with the opening run.
      let cursor = 0;
      while (cursor < 3 && line[cursor] === " ") cursor += 1;
      const runStart = cursor;
      while (line[cursor] === fenceCharacter) cursor += 1;
      if (
        cursor - runStart >= fenceLength &&
        /^[ \t]*$/.test(line.slice(cursor))
      ) {
        fenceCharacter = undefined;
        fenceLength = 0;
      }
    } else {
      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (opening) {
        fenceCharacter = opening[1][0] as "`" | "~";
        fenceLength = opening[1].length;
        indented = false;
        isProtected = true;
      } else if (/^(?: {4}|\t)/.test(line)) {
        indented = true;
        isProtected = true;
      } else if (indented && /^[ \t]*$/.test(line)) {
        isProtected = true;
      } else {
        indented = false;
      }
    }

    if (blockProtected === undefined) {
      blockProtected = isProtected;
    } else if (blockProtected !== isProtected) {
      blocks.push({
        text: text.slice(blockStart, lineStart),
        protected: blockProtected,
      });
      blockStart = lineStart;
      blockProtected = isProtected;
    }
  }
  if (blockProtected !== undefined) {
    blocks.push({ text: text.slice(blockStart), protected: blockProtected });
  }
  return blocks;
}
