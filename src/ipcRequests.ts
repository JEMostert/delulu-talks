import type {
  AppSettings,
  CustomWord,
  MagicPreset,
  MagicRewriteRequest,
  RecordingSubmission,
} from "./types";

/** Runtime contracts for renderer requests; no Electron or platform dependencies. */
type RequestSchema = { parse(args: readonly unknown[]): unknown[] };
type ObjectInput = Record<string, unknown>;

function object(value: unknown, label: string): ObjectInput {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new Error(`Expected ${label} object`);
  return value as ObjectInput;
}

export function requestText(value: unknown, max: number): string {
  if (typeof value !== "string") throw new Error("Expected text input");
  return value.slice(0, max);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`Expected a finite ${label}`);
  return value;
}

function optionalBoolean(source: ObjectInput, key: string): void {
  if (source[key] !== undefined && typeof source[key] !== "boolean")
    throw new Error(`Expected ${key} to be a boolean`);
}

function optionalString(source: ObjectInput, key: string): void {
  if (source[key] !== undefined && typeof source[key] !== "string")
    throw new Error(`Expected ${key} to be text`);
}

function schema(
  count: number,
  parse: (args: readonly unknown[]) => unknown[] = () => [],
): RequestSchema {
  return {
    parse(args) {
      if (args.length !== count)
        throw new Error(`Expected ${count} request arguments`);
      return parse(args);
    },
  };
}

const settingsBooleans = [
  "onboardingComplete", "autoPaste", "copyToClipboard", "keepHistory",
  "showOverlay", "preloadModel", "magicEnabled", "magicAllowInferences",
  "preloadMagicModel", "launchAtLogin",
] as const;
const settingsStrings = {
  theme: 512,
  shortcut: 96,
  shortcutMode: 512,
  model: 512,
  language: 12,
  pythonCommand: 512,
  inputDeviceId: 512,
  inputDeviceLabel: 512,
  pastePortalToken: 4096,
  magicModel: 512,
  magicPreset: 512,
} as const;

function parseCustomWords(value: unknown): CustomWord[] {
  if (!Array.isArray(value)) throw new Error("Expected customWords array");
  return value.slice(0, 500).map((value) => {
    const word = object(value, "custom word");
    optionalString(word, "kind");
    optionalBoolean(word, "enabled");
    // Storage continues to supply legacy defaults and normalize empty terms.
    const parsed: ObjectInput = {};
    for (const [key, max] of Object.entries({
      id: 128, term: 256, soundsLike: 1024, replacement: 4096,
    })) {
      optionalString(word, key);
      if (word[key] !== undefined)
        parsed[key] = requestText((word[key] as string).trim(), max);
    }
    if (word.kind !== undefined) parsed.kind = word.kind;
    if (word.enabled !== undefined) parsed.enabled = word.enabled;
    return parsed as CustomWord;
  });
}

export function parseSettingsPatch(value: unknown): Partial<AppSettings> {
  const source = object(value, "settings");
  const allowed = new Set([
    "workflowVersion", "modelIdleMinutes", "customWords",
    ...settingsBooleans, ...Object.keys(settingsStrings),
  ]);
  for (const key of Object.keys(source))
    if (!allowed.has(key)) throw new Error(`Unknown setting: ${key}`);
  const patch: ObjectInput = {};
  for (const key of settingsBooleans) {
    optionalBoolean(source, key);
    if (source[key] !== undefined) patch[key] = source[key];
  }
  for (const [key, max] of Object.entries(settingsStrings)) {
    optionalString(source, key);
    if (source[key] !== undefined)
      patch[key] = requestText(
        ["shortcut", "language", "pythonCommand", "inputDeviceId", "inputDeviceLabel", "pastePortalToken"].includes(key)
          ? (source[key] as string).trim()
          : source[key],
        max,
      );
  }
  if (source.workflowVersion !== undefined) {
    if (source.workflowVersion !== 1)
      throw new Error("Unsupported settings workflowVersion");
    patch.workflowVersion = 1;
  }
  if (source.modelIdleMinutes !== undefined)
    patch.modelIdleMinutes = finiteNumber(source.modelIdleMinutes, "model idle time");
  if (source.customWords !== undefined)
    patch.customWords = parseCustomWords(source.customWords);
  return patch as Partial<AppSettings>;
}

const magicPresets = ["polish", "concise", "structured", "prompt"];
const magicModels = ["qwen35Small", "qwen35Medium", "qwen35Large"];

export function parseMagicRequest(value: unknown): MagicRewriteRequest {
  const source = object(value, "Magic rewrite request");
  optionalString(source, "preset");
  optionalBoolean(source, "allowInferences");
  const request: MagicRewriteRequest = {
    text: requestText(source.text, 50_000).trim(),
    preset: magicPresets.includes(String(source.preset))
      ? source.preset as MagicPreset
      : "polish",
    instructions: requestText(source.instructions ?? "", 4_000).trim(),
    allowInferences: source.allowInferences === true,
  };
  if (!request.text)
    throw new Error("Add a transcript or draft before using Magic");
  return request;
}

export function parseRecording(value: unknown): RecordingSubmission {
  const source = object(value, "recording");
  const durationMs = finiteNumber(source.durationMs, "recording duration");
  if (durationMs < 0) throw new Error("Invalid recording duration");
  // ArrayBuffer.isView also accepts typed arrays copied across renderer realms.
  const wav = source.wav;
  if (
    !ArrayBuffer.isView(wav) ||
    Object.prototype.toString.call(wav) !== "[object Uint8Array]" ||
    wav.byteLength < 44
  )
    throw new Error("The microphone returned an empty recording");
  if (wav.byteLength > 500 * 1024 * 1024)
    throw new Error("Recording is too large; keep dictation captures below 500 MB");
  return { wav: wav as Uint8Array, durationMs };
}

function parseRewriteResult(value: unknown): ObjectInput | null {
  if (value === null) return null;
  const source = object(value, "rewrite");
  optionalString(source, "preset");
  optionalString(source, "model");
  optionalBoolean(source, "includedInferences");
  for (const key of ["inputCharacters", "outputCharacters"])
    if (source[key] !== undefined && finiteNumber(source[key], key) < 0)
      throw new Error(`Invalid ${key}`);
  const text = requestText(source.text, 500_000).trim();
  if (!text) throw new Error("A rewrite cannot be empty");
  const processingTimeMs = source.processingTimeMs === undefined
    ? 0
    : Math.max(0, finiteNumber(source.processingTimeMs, "rewrite processing time"));
  return {
    text,
    preset: magicPresets.includes(String(source.preset)) ? source.preset : undefined,
    model: magicModels.includes(String(source.model)) ? source.model : undefined,
    includedInferences: source.includedInferences === true,
    processingTimeMs,
  };
}

const noArguments = schema(0);

export const ipcRequestSchemas = {
  "renderer:recoveryState": noArguments,
  "renderer:reload": noArguments,
  "renderer:controllerFailed": noArguments,
  "runtime:diagnostics": noArguments,
  "dictation:pasteLast": noArguments,
  "dictation:discardFailed": noArguments,
  "dictation:retry": noArguments,
  "settings:get": noArguments,
  "settings:update": schema(1, ([value]) => [parseSettingsPatch(value)]),
  "runtime:status": noArguments,
  "shortcut:status": noArguments,
  "shortcut:configure": noArguments,
  "runtime:setup": noArguments,
  "runtime:load": noArguments,
  "runtime:unload": noArguments,
  "runtime:reset": noArguments,
  "magic:status": noArguments,
  "magic:setup": noArguments,
  "magic:load": noArguments,
  "magic:unload": noArguments,
  "magic:rewrite": schema(1, ([value]) => [parseMagicRequest(value)]),
  "platform:capabilities": noArguments,
  "updates:get": noArguments,
  "updates:check": noArguments,
  "updates:download": noArguments,
  "updates:install": noArguments,
  "dictation:start": noArguments,
  "dictation:stop": noArguments,
  "dictation:toggle": noArguments,
  "dictation:cancel": noArguments,
  "recorder:started": noArguments,
  "recorder:ready": noArguments,
  "recorder:failed": schema(1, ([value]) => [requestText(value, 1000)]),
  "recorder:submit": schema(1, ([value]) => [parseRecording(value)]),
  "recorder:level": schema(1, ([value]) => [
    Math.min(1, Math.max(0, finiteNumber(value, "recording level"))),
  ]),
  "clipboard:copy": schema(1, ([value]) => [requestText(value, 500_000)]),
  "paste:authorize": noArguments,
  "paste:test": noArguments,
  "history:get": noArguments,
  "history:updateTranscript": schema(2, ([id, text]) => [
    requestText(id, 128), text === null ? null : requestText(text, 500_000),
  ]),
  "history:setRewrite": schema(3, ([id, value, expected]) => [
    requestText(id, 128), parseRewriteResult(value), requestText(expected, 500_000),
  ]),
  "history:delete": schema(1, ([id]) => [requestText(id, 128)]),
  "history:clear": noArguments,
  "lab:chooseAudio": noArguments,
  "lab:run": schema(1, ([value]) => [
    { path: requestText(object(value, "audio file request").path, 4096) },
  ]),
  "history:export": schema(2, ([id, format]) => {
    if (typeof format !== "string") throw new Error("Expected export format text");
    return [requestText(id, 128), ["txt", "json"].includes(format) ? format : "txt"];
  }),
} satisfies Record<string, RequestSchema>;

export type IpcRequestChannel = keyof typeof ipcRequestSchemas;

export function parseIpcRequest(
  channel: string,
  args: readonly unknown[],
): unknown[] {
  if (!Object.prototype.hasOwnProperty.call(ipcRequestSchemas, channel))
    throw new Error(`Unknown IPC request: ${channel}`);
  return ipcRequestSchemas[channel as IpcRequestChannel].parse(args);
}
