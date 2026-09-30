import type { TranscriptRecord } from "./types";

export type ExportTextSource =
  "original" | "corrected" | "personalized" | "rewritten";

export type ExportTemplateSpec = {
  template: string;
  source: ExportTextSource;
  extension: "txt" | "md";
};

export interface ExportTemplateRequest extends ExportTemplateSpec {
  expectedOutput: string;
}

export const MAX_EXPORT_TEMPLATE_LENGTH = 32768;
export const MAX_EXPORT_OUTPUT_LENGTH = 8000000;

export const EXPORT_TEMPLATE_TOKENS = [
  "text",
  "id",
  "createdAt",
  "model",
  "language",
  "source",
  "sourceName",
] as const;

export const EXPORT_TEMPLATE_PRESETS = [
  {
    id: "plain",
    label: "Plain text",
    template: "{{text}}",
    extension: "txt",
  },
  {
    id: "metadata",
    label: "Text with metadata",
    template:
      "Transcript: {{id}}\nCreated: {{createdAt}}\nModel: {{model}}\nLanguage: {{language}}\nSource: {{source}}\nSource name: {{sourceName}}\n\n{{text}}",
    extension: "txt",
  },
  {
    id: "markdown",
    label: "Markdown note",
    template:
      "# Transcript\n\nCreated: {{createdAt}}\nModel: {{model}}\nLanguage: {{language}}\nSource: {{source}}\nSource name: {{sourceName}}\n\n{{text}}",
    extension: "md",
  },
] as const;

export function exportTemplateText(
  record: TranscriptRecord,
  source: ExportTextSource,
): string {
  let text: unknown;
  switch (source) {
    case "original":
      text = record.text;
      break;
    case "corrected":
      text = record.editedText;
      break;
    case "personalized":
      text = record.personalizedText;
      break;
    case "rewritten":
      text = record.magicText;
      break;
    default:
      throw new Error("Choose a supported transcript version.");
  }
  if (typeof text !== "string")
    throw new Error(`The ${source} transcript version is unavailable.`);
  return text;
}

export function defaultExportTextSource(
  record: TranscriptRecord,
): ExportTextSource {
  if (record.magicText != null) return "rewritten";
  if (record.editedText != null) return "corrected";
  if (record.personalizedText != null) return "personalized";
  return "original";
}

const REQUEST_FIELDS = ["template", "source", "extension", "expectedOutput"];

function plainDataObject(input: unknown): object {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new Error("Export template options must be a plain object.");
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !REQUEST_FIELDS.includes(key))
      throw new Error("Export template options contain an unknown field.");
    if (
      !Object.prototype.hasOwnProperty.call(
        Object.getOwnPropertyDescriptor(input, key)!,
        "value",
      )
    )
      throw new Error("Export template options must contain literal values.");
  }
  return input;
}

function value(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value"))
    throw new Error(`Export template options require ${key}.`);
  return descriptor.value;
}

function templateSpec(input: object): ExportTemplateSpec {
  const template = value(input, "template");
  const source = value(input, "source");
  const extension = value(input, "extension");
  if (
    typeof template !== "string" ||
    template.length > MAX_EXPORT_TEMPLATE_LENGTH
  )
    throw new Error(
      `Export templates must contain at most ${MAX_EXPORT_TEMPLATE_LENGTH} characters.`,
    );
  if (
    source !== "original" &&
    source !== "corrected" &&
    source !== "personalized" &&
    source !== "rewritten"
  )
    throw new Error("Choose a supported transcript version.");
  if (extension !== "txt" && extension !== "md")
    throw new Error("Choose a text or Markdown export.");
  return { template, source, extension };
}

type Token = (typeof EXPORT_TEMPLATE_TOKENS)[number];
type Segment = { literal: string } | { token: Token };

/** Scan template syntax once; substituted values never enter this parser. */
function segments(template: string): Segment[] {
  const result: Segment[] = [];
  let literalStart = 0;
  let hasText = false;
  for (let index = 0; index < template.length;) {
    if (template.startsWith("}}", index))
      throw new Error(
        "Export template contains an unmatched closing placeholder.",
      );
    if (!template.startsWith("{{", index)) {
      index++;
      continue;
    }
    if (index > literalStart)
      result.push({ literal: template.slice(literalStart, index) });
    const end = template.indexOf("}}", index + 2);
    if (end === -1)
      throw new Error("Export template contains an unfinished placeholder.");
    const name = template.slice(index + 2, end);
    if (!EXPORT_TEMPLATE_TOKENS.some((token) => token === name))
      throw new Error(`Unknown or malformed export placeholder: {{${name}}}.`);
    const token = name as Token;
    if (token === "text") hasText = true;
    result.push({ token });
    index = end + 2;
    literalStart = index;
  }
  if (literalStart < template.length)
    result.push({ literal: template.slice(literalStart) });
  if (!hasText) throw new Error("Export templates must include {{text}}.");
  return result;
}

export function validateExportTemplateRequest(
  input: unknown,
): ExportTemplateRequest {
  const object = plainDataObject(input);
  const spec = templateSpec(object);
  const expectedOutput = value(object, "expectedOutput");
  if (
    typeof expectedOutput !== "string" ||
    expectedOutput.length > MAX_EXPORT_OUTPUT_LENGTH
  )
    throw new Error(
      `Export preview must contain at most ${MAX_EXPORT_OUTPUT_LENGTH} characters.`,
    );
  segments(spec.template);
  return { ...spec, expectedOutput };
}

export function renderExportTemplate(
  record: TranscriptRecord,
  spec: ExportTemplateSpec,
): string {
  const validated = templateSpec(plainDataObject(spec));
  const parts = segments(validated.template);
  const createdAt = new Date(record.createdAt);
  if (
    typeof record.createdAt !== "number" ||
    !Number.isFinite(record.createdAt) ||
    Number.isNaN(createdAt.getTime())
  )
    throw new Error("This transcript has an invalid creation date.");
  const metadata: Record<Token, string> = {
    text: exportTemplateText(record, validated.source),
    id: record.id,
    createdAt: createdAt.toISOString(),
    model: record.model,
    language: record.language,
    source: record.source,
    sourceName: record.sourceName ?? "",
  };
  const output: string[] = [];
  let length = 0;
  for (const part of parts) {
    const text = "literal" in part ? part.literal : metadata[part.token];
    if (typeof text !== "string")
      throw new Error("This transcript contains invalid export metadata.");
    if (text.length > MAX_EXPORT_OUTPUT_LENGTH - length)
      throw new Error(
        `Rendered export must contain at most ${MAX_EXPORT_OUTPUT_LENGTH} characters.`,
      );
    length += text.length;
    output.push(text);
  }
  return output.join("");
}
