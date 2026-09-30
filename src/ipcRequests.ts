import { DEFAULT_SETTINGS } from "./data";
import { REWRITE_PRESETS } from "./rewritePresets";
import { normalizeTimings } from "./pipelineTimings";
import { normalizeCaptureDiagnostics } from "./captureDiagnostics";
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
    const parsed: ObjectInput = { ...object(jsonInput(word), "custom word") };
    for (const [key, max] of Object.entries({
      id: 128, term: 256, soundsLike: 1024, replacement: 4096,
    })) {
      optionalString(word, key);
      if (word[key] !== undefined)
        parsed[key] = requestText(key === "replacement" ? word[key] : (word[key] as string).trim(), max);
    }
    if (word.kind !== undefined) parsed.kind = word.kind;
    if (word.enabled !== undefined) parsed.enabled = word.enabled;
    return parsed as CustomWord;
  });
}

export function parseSettingsPatch(value: unknown): Partial<AppSettings> {
  const source = object(value, "settings");
  const patch: ObjectInput = {};
  for (const [key, value] of Object.entries(source)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new Error(`Unknown setting: ${key}`);
    if (value === undefined) continue;
    const fallback = DEFAULT_SETTINGS[key as keyof AppSettings];
    if (typeof fallback === "boolean" && typeof value !== "boolean") throw new Error(`Expected ${key} boolean`);
    if (typeof fallback === "number") finiteNumber(value, key);
    if (typeof fallback === "string") requestText(value, 4096);
    if (key === "customWords") patch[key] = parseCustomWords(value);
    else if (fallback && typeof fallback === "object") { jsonInput(value); patch[key] = value; }
    else patch[key] = value;
  }
  if (source.schemaVersion !== undefined && source.schemaVersion !== 1) throw new Error("Unsupported settings schema version");
  if (source.workflowVersion !== undefined && source.workflowVersion !== 1) throw new Error("Unsupported workflow version");
  return patch as Partial<AppSettings>;
}

function jsonInput(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new Error("Request nesting is too deep");
  if (value === null || value === undefined || typeof value === "boolean") return value;
  if (typeof value === "number") return finiteNumber(value, "request number");
  if (typeof value === "string") return requestText(value, 500_000);
  if (Array.isArray(value)) { if (value.length > 1000) throw new Error("Request list is too long"); return value.map(item => jsonInput(item,depth+1)); }
  const source = object(value,"request");
  return Object.fromEntries(Object.entries(source).map(([key,item]) => [key,jsonInput(item,depth+1)]));
}

const magicPresets = REWRITE_PRESETS.map(preset => preset.id);
const magicModels = ["qwen35Small", "qwen35Medium", "qwen35Large"];

export function parseMagicRequest(value: unknown): MagicRewriteRequest {
  const source = object(value, "Magic rewrite request");
  optionalString(source, "preset");
  optionalBoolean(source, "allowInferences");
  const request: MagicRewriteRequest = {
    text: requestText(source.text, 50_000),
    context: source.context === undefined ? undefined : jsonInput(source.context) as MagicRewriteRequest["context"],
    operationId: source.operationId === undefined ? undefined : requestText(source.operationId,128),
    sourceLanguage: source.sourceLanguage === undefined ? undefined : requestText(source.sourceLanguage,64),
    preset: magicPresets.includes(String(source.preset))
      ? source.preset as MagicPreset
      : "polish",
    instructions: requestText(source.instructions ?? "", 4_000).trim(),
    allowInferences: source.allowInferences === true,
  };
  if (!request.text.trim())
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
  return { wav: wav as Uint8Array, durationMs, sessionId: requestText(source.sessionId,128), timings: normalizeTimings(source.timings) ?? undefined, captureDiagnostics: normalizeCaptureDiagnostics(source.captureDiagnostics) ?? undefined };
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
  const text = requestText(source.text, 500_000);
  if (!text.trim()) throw new Error("A rewrite cannot be empty");
  const processingTimeMs = source.processingTimeMs === undefined
    ? 0
    : Math.max(0, finiteNumber(source.processingTimeMs, "rewrite processing time"));
  return {
    text,
    preset: magicPresets.includes(String(source.preset)) ? source.preset : undefined,
    model: magicModels.includes(String(source.model)) ? source.model : undefined,
    includedInferences: source.includedInferences === true,
    processingTimeMs,
    timings: normalizeTimings(source.timings),
  };
}

const noArguments = schema(0);

function stringIds(value: unknown, limit = 128, count = 500): string[] {
 if (!Array.isArray(value) || value.length > count) throw new Error("Invalid selection list");
 const ids = value.map(item => requestText(item,limit));
 if (new Set(ids).size !== ids.length) throw new Error("Duplicate selection entries");
 return ids;
}

export const ipcRequestSchemas = {

  "cache:preview": noArguments, "cache:cleanup": schema(2, ([token, ids]) => [requestText(token,128), stringIds(ids)]),
  "rules:usage": noArguments, "rules:resetUsage": noArguments,
  "dictation:pasteLastStatus": noArguments, "dictation:cancelPasteLast": noArguments,
  "history:batchSnapshot": noArguments, "history:stageDeletion": schema(1, ([ids]) => [stringIds(ids)]),
  "history:undoDeletion": schema(1, ([token]) => [requestText(token,128)]),
  "history:exportSelection": schema(2, ([ids,format]) => [stringIds(ids),requestText(format,16)]),
  "history:encryptedExport": schema(1, ([password]) => [requestText(password,1024)]),
  "history:encryptedRecover": schema(1, ([password]) => [requestText(password,1024)]),
  "history:retentionPreview": schema(1, ([policy]) => [jsonInput(policy)]),
  "history:retentionApply": schema(1, ([token]) => [requestText(token,128)]),
  "history:setTitle": schema(2, ([id,title]) => [requestText(id,128),title === null ? null : requestText(title,512)]),
  "history:exportTemplate": schema(2, ([id,request]) => [requestText(id,128),jsonInput(request)]),
  "lab:chooseAudioFiles": noArguments, "lab:getJobs": noArguments,
  "lab:loadSource": schema(1, ([path]) => [requestText(path,4096)]),
  "lab:removeJob": schema(1, ([path]) => [requestText(path,4096)]),
  "lab:relinkJob": schema(1, ([path]) => [requestText(path,4096)]),
  "lab:resolveAudioFiles": schema(1, ([paths]) => [stringIds(paths,4096,50)]),
  "lab:queueGet": noArguments, "lab:queueClearFinished": noArguments,
  "lab:queueEnqueue": schema(1, ([path]) => [requestText(path,4096)]),
  "lab:queuePause": schema(1, ([paused]) => { if (typeof paused !== "boolean") throw new Error("Expected pause boolean"); return [paused]; }),
  "lab:queueMove": schema(2, ([id,direction]) => { if (direction !== -1 && direction !== 1) throw new Error("Expected move direction"); return [requestText(id,128),direction]; }),
  "lab:queueCancel": schema(1, ([id]) => [requestText(id,128)]),
  "lab:queueRetry": schema(1, ([id]) => [requestText(id,128)]),
  "magic:cancelRewrite": schema(1, ([id]) => [requestText(id,128)]),
  "paste:recovery": noArguments, "paste:copyInstead": noArguments, "paste:dismissRecovery": noArguments,
  "profiles:manage": schema(1, ([command]) => [jsonInput(command)]),
  "recorder:limit": schema(1, ([id]) => [requestText(id,128)]),
  "recorder:inputChanged": schema(3, ([id,message,lost]) => { if (typeof lost !== "boolean") throw new Error("Expected lost-input boolean"); return [requestText(id,128),requestText(message,1000),lost]; }),
  "runtime:setupLog": noArguments, "runtime:setupSnapshot": noArguments, "storage:overview": noArguments,

  "projectVocabulary:choose": schema(1, ([value]) => [jsonInput(value)]),
  "projectVocabulary:get": noArguments, "projectVocabulary:refresh": noArguments, "projectVocabulary:clear": noArguments, "projectVocabulary:select": noArguments,
  "selectedText:state": noArguments,
  "selectedText:enable": schema(1, ([value]) => { if (typeof value !== "boolean") throw new Error("Expected selection consent boolean"); return [value]; }),
  "selectedText:discard": schema(1, ([id]) => [requestText(id,128)]),
  "selectedText:replace": schema(2, ([id,text]) => [requestText(id,128),requestText(text,500_000)]),
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
  "runtime:cancelSetup": noArguments,
  "runtime:load": noArguments,
  "runtime:unload": noArguments,
  "runtime:reset": noArguments,
  "magic:status": noArguments,
  "magic:setup": noArguments,
  "magic:cancelSetup": noArguments,
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
  "recorder:started": schema(1, ([id]) => [requestText(id,128)]),
  "recorder:ready": noArguments,
  "recorder:failed": schema(2, ([value,id]) => [requestText(value, 1000), requestText(id,128)]),
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
  "history:setRewrite": schema(4, ([id, value, expected, revision]) => [
    requestText(id, 128), parseRewriteResult(value), requestText(expected, 500_000), revision === undefined ? undefined : finiteNumber(revision,"source revision"),
  ]),
  "history:delete": schema(1, ([id]) => [requestText(id, 128)]),
  "history:clear": noArguments,
  "lab:chooseAudio": noArguments,
  "lab:inspectAudio": schema(1, ([path]) => [requestText(path, 4096)]),
  "lab:run": schema(1, ([value]) => [
    { path: requestText(object(value, "audio file request").path, 4096) },
  ]),
  "history:export": schema(2, ([id, format]) => {
    if (typeof format !== "string") throw new Error("Expected export format text");
    return [requestText(id, 128), ["txt", "json", "md"].includes(format) ? format : "txt"];
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
