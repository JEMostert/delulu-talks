import type { Settings, Status, HistoryEntry, ModelDownload } from "./ipc";
import type {
  Event,
  EventName,
  EventCallback,
  UnlistenFn,
} from "@tauri-apps/api/event";

let settings: Settings = {
  version: 1,
  microphone: null,
  startAtLogin: false,
  model: "large-v3-turbo-q5_0",
  language: "auto",
  insert: "shift-insert",
  theme: "system",
};
let status: Status = {
  phase: new URLSearchParams(location.search).has("firstRun")
    ? "needsSetup"
    : "idle",
  message: null,
  hotkey: { bound: true, trigger: "Super+Z", error: null },
  insert: { ready: false, error: null },
  backend: "Stub backend",
  model: null,
};
let history: HistoryEntry[] = [];
const downloaded = new Set<string>();
let mic: ReturnType<typeof setInterval> | undefined;
let download: ReturnType<typeof setInterval> | undefined;
const listeners = new Map<string, Set<(value: never) => void>>();
function emit(name: string, value: unknown) {
  listeners.get(name)?.forEach((fn) => fn(value as never));
}
export async function listen<T>(
  event: EventName,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  const key = String(event);
  const callbacks = listeners.get(key) ?? new Set();
  const callback = (value: never) =>
    handler({ event: key, id: 0, payload: value } as Event<T>);
  callbacks.add(callback);
  listeners.set(key, callbacks);
  return () => {
    callbacks.delete(callback);
  };
}
export async function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  let result: unknown;
  switch (command) {
    case "get_status":
      result = status;
      break;
    case "get_settings":
      result = settings;
      break;
    case "set_settings":
      settings = args!.settings as Settings;
      result = settings;
      break;
    case "list_microphones":
      result = [{ id: "stub", name: "Example microphone", isDefault: true }];
      break;
    case "list_languages":
      result = [
        { code: "en", name: "english" },
        { code: "nl", name: "dutch" },
      ];
      break;
    case "list_models":
      result = [
        {
          id: "large-v3-turbo-q5_0",
          label: "Large v3 Turbo (recommended)",
          bytes: 574041195,
          downloaded: downloaded.has("large-v3-turbo-q5_0"),
        },
        {
          id: "small",
          label: "Small (faster, weaker Dutch)",
          bytes: 487601967,
          downloaded: downloaded.has("small"),
        },
      ];
      break;
    case "start_mic_test":
      clearInterval(mic);
      mic = setInterval(
        () => emit("mic-level", 0.1 + Math.random() * 0.55),
        50,
      );
      break;
    case "stop_mic_test":
      clearInterval(mic);
      emit("mic-level", 0);
      break;
    case "prepare_insert":
      status = { ...status, insert: { ready: true, error: null } };
      emit("status", status);
      result = status.insert;
      break;
    case "download_model": {
      const id = String(args!.id);
      let done = 0;
      clearInterval(download);
      download = setInterval(() => {
        done += 10;
        const progress: ModelDownload = {
          id,
          doneBytes: done,
          totalBytes: 100,
          finished: done >= 100,
          error: null,
        };
        if (progress.finished) {
          clearInterval(download);
          downloaded.add(id);
        }
        emit("model-download", progress);
      }, 300);
      break;
    }
    case "cancel_download":
      clearInterval(download);
      break;
    case "get_history":
      result = history
        .filter((e) =>
          e.text
            .toLowerCase()
            .includes(String(args?.query ?? "").toLowerCase()),
        )
        .slice(0, Number(args?.limit ?? 100));
      break;
    case "delete_history":
      history = history.filter((e) => e.id !== args?.id);
      break;
    case "clear_history":
      history = [];
      break;
    case "copy_text":
      await navigator.clipboard.writeText(String(args?.text));
      break;
    case "reinsert":
      result = { kind: "copied", reason: null };
      break;
    case "finish_first_run":
      status = { ...status, phase: "idle" };
      emit("status", status);
      break;
    case "start_dictation":
      status = { ...status, phase: "recording" };
      emit("status", status);
      break;
    case "stop_dictation": {
      status = { ...status, phase: "transcribing" };
      emit("status", status);
      setTimeout(() => {
        const entry: HistoryEntry = {
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          text: "Stub transcript",
          language: "en",
          model: settings.model,
          audioMs: 1000,
          sttMs: 200,
          totalMs: 350,
        };
        history.unshift(entry);
        emit("transcript", { entry, insert: { kind: "copied", reason: null } });
        status = { ...status, phase: "idle" };
        emit("status", status);
      }, 500);
      break;
    }
  }
  return result as T;
}
