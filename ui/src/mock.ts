import type {
  Settings,
  Status,
  HistoryEntry,
  ModelDownload,
  CleanupStatus,
  Shelf,
} from "./ipc";
import { splitTerms } from "./helpers";
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
  overlay: true,
  firstRunDone: !new URLSearchParams(location.search).has("firstRun"),
  cleanup: true,
  cleanupModelOk: true,
};
// Dev-only URL switches: ?firstRun, ?empty, ?phase=error|loadingModel|…
const params = new URLSearchParams(location.search);
const cleanupParam = params.get("cleanup") as CleanupStatus["state"] | null;
let cleanupStatus: CleanupStatus = {
  state: cleanupParam ?? "ready",
  doneBytes: 2500000000,
  totalBytes: 5154941280,
  error: cleanupParam === "error" ? "Could not load cleanup." : null,
  backend: null,
};
if (cleanupParam === "off") settings.cleanup = false;
if (cleanupParam === "missing") settings.cleanupModelOk = false;
let cleanupDownload: ReturnType<typeof setInterval> | undefined;
const demoShelves = (): Shelf[] => [
  {
    id: crypto.randomUUID(),
    name: "Programming",
    enabled: true,
    terms: ["T3 Code", "Tauri", "Claude Code"],
  },
  {
    id: crypto.randomUUID(),
    name: "Places",
    enabled: false,
    terms: ["Scheveningen", "Utrecht"],
  },
];
const VOCABULARY_KEY = "mock-vocabulary";
/** Shelves saved by an earlier mock session, or undefined. */
function storedShelves(): Shelf[] | undefined {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(VOCABULARY_KEY) ?? "null",
    );
    const ok =
      Array.isArray(value) &&
      value.every(
        (s) =>
          typeof s?.id === "string" &&
          typeof s.name === "string" &&
          typeof s.enabled === "boolean" &&
          Array.isArray(s.terms) &&
          s.terms.every((t: unknown) => typeof t === "string"),
      );
    return ok ? (value as Shelf[]) : undefined;
  } catch {
    return undefined;
  }
}
// ?empty also starts without vocabularies; otherwise they survive a reload.
let shelves: Shelf[] = params.has("empty")
  ? []
  : (storedShelves() ?? demoShelves());
// Short stand-ins for the Rust PRESETS; the real lists live in crates/store.
const presets = [
  {
    key: "programming",
    name: "Programming",
    terms: ["T3 Code", "Claude Code", "Codex", "TypeScript", "Tauri", "Rust"],
  },
  {
    key: "gaming-discord",
    name: "Gaming & Discord",
    terms: ["Discord", "Steam Deck", "Valorant", "League of Legends", "GG"],
  },
  {
    key: "twitch-streaming",
    name: "Twitch & Streaming",
    terms: ["Twitch", "OBS", "VOD", "PogChamp", "KEKW", "hype train"],
  },
];
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Like delulu_cleanup::vocabulary_terms: at most 100 terms and 1,500 characters. */
function usedTerms(active: string[]) {
  let used = 0;
  let chars = 0;
  for (const term of active) {
    chars += [...term].length;
    if (used === 100 || chars > 1500) break;
    used += 1;
  }
  return used;
}
/** The backend's rules, in short: tidy, dedupe, cap. Saves for the next reload. */
function vocabulary() {
  try {
    localStorage.setItem(VOCABULARY_KEY, JSON.stringify(shelves));
  } catch {
    // Storage full or blocked: the mock just forgets on reload.
  }
  const active: string[] = [];
  for (const shelf of shelves.filter((s) => s.enabled))
    for (const term of shelf.terms)
      if (!active.some((t) => same(t, term))) active.push(term);
  return {
    version: 1,
    shelves,
    presets: presets.filter((p) => !shelves.some((s) => same(s.name, p.name))),
    activeTerms: active.length,
    usedTerms: usedTerms(active),
  };
}
function changeShelf(id: unknown, change: (shelf: Shelf) => Shelf) {
  if (!shelves.some((s) => s.id === id)) throw "That shelf no longer exists.";
  shelves = shelves.map((s) => (s.id === id ? change(s) : s));
}
function shelfName(name: unknown, except?: unknown) {
  const tidy = splitTerms(String(name)).join(" ");
  if (!tidy) throw "Give the shelf a name.";
  if (tidy.length > 40) throw "Shelf names can be at most 40 characters.";
  if (shelves.some((s) => s.id !== except && same(s.name, tidy)))
    throw `There is already a shelf called “${tidy}”.`;
  return tidy;
}
const startPhase = params.get("phase") as Status["phase"] | null;
let status: Status = {
  phase: params.has("firstRun") ? "needsSetup" : (startPhase ?? "idle"),
  message:
    startPhase === "error"
      ? "The microphone stopped sending sound. Check that it is plugged in."
      : null,
  dataDir: "/home/example/.local/share/delulu-talks",
  hotkey: { bound: true, trigger: "Super+Z", error: null },
  insert: { ready: false, error: null },
  backend: "Stub backend",
  model: null,
};
const samples: [string, string][] = [
  [
    "en",
    "Can you move the stand-up to half past ten? I need to finish the release notes first.",
  ],
  ["nl", "Vergeet niet om morgen de boodschappen te halen, vooral de koffie."],
  [
    "en",
    "Refactor the settings loader so it falls back to defaults when the file is missing.",
  ],
  ["nl", "Ik ben er over tien minuten, de trein had vertraging."],
  ["en", "Thanks, that fixed it."],
  [
    "en",
    "Let's ship the pearl redesign behind a flag and see how it feels for a week.",
  ],
  ["nl", "Kun je de foto's van zaterdag even in de gedeelde map zetten?"],
  [
    "en",
    "Note to self: the Vulkan backend is faster on large-v3-turbo than CUDA was.",
  ],
];
const sampleEntry = (i: number, createdAt: number): HistoryEntry => {
  const [language, text] = samples[i % samples.length];
  const audioMs = 1200 + text.length * 45;
  return {
    id: crypto.randomUUID(),
    createdAt,
    text,
    raw:
      i === 0
        ? "Um, can you move the stand-up to half past ten? I need to finish the release notes first."
        : undefined,
    language,
    model: settings.model,
    audioMs,
    sttMs: 180 + (i % 4) * 70,
    totalMs: 260 + (i % 5) * 90,
  };
};
let history: HistoryEntry[] = params.has("empty")
  ? []
  : samples.map((_, i) =>
      sampleEntry(
        i,
        Date.now() - [4, 38, 190, 1500, 1700, 2900, 4400, 9000][i] * 60000,
      ),
    );
let spoken = 0;
let voice: ReturnType<typeof setInterval> | undefined;
const downloaded = new Set<string>(
  params.has("firstRun") ? [] : [settings.model],
);
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
    case "get_vocabulary":
      result = vocabulary();
      break;
    case "add_shelf":
      if (shelves.length >= 32) throw "You can have at most 32 shelves.";
      shelves = [
        ...shelves,
        {
          id: crypto.randomUUID(),
          name: shelfName(args?.name),
          enabled: true,
          terms: [],
        },
      ];
      result = vocabulary();
      break;
    case "add_preset_shelf": {
      const preset = presets.find((p) => p.key === args?.key);
      if (!preset) throw "That starter shelf doesn’t exist.";
      if (shelves.length >= 32) throw "You can have at most 32 shelves.";
      shelves = [
        ...shelves,
        {
          id: crypto.randomUUID(),
          name: shelfName(preset.name),
          enabled: true,
          terms: [...preset.terms],
        },
      ];
      result = vocabulary();
      break;
    }
    case "rename_shelf": {
      const name = shelfName(args?.name, args?.id);
      changeShelf(args?.id, (s) => ({ ...s, name }));
      result = vocabulary();
      break;
    }
    case "delete_shelf":
      shelves = shelves.filter((s) => s.id !== args?.id);
      result = vocabulary();
      break;
    case "set_shelf_enabled":
      changeShelf(args?.id, (s) => ({ ...s, enabled: Boolean(args?.enabled) }));
      result = vocabulary();
      break;
    case "add_terms":
      changeShelf(args?.id, (s) => {
        const terms = [...s.terms];
        for (const term of splitTerms(String(args?.text))) {
          if (term.length > 48)
            throw `“${term}” is too long; terms can be at most 48 characters.`;
          if (/[<>]/.test(term)) throw `“${term}” can’t contain < or >.`;
          if (!terms.some((t) => same(t, term))) terms.push(term);
        }
        if (terms.length > 200) throw "A shelf can hold at most 200 terms.";
        return { ...s, terms };
      });
      result = vocabulary();
      break;
    case "remove_term":
      changeShelf(args?.id, (s) => ({
        ...s,
        terms: s.terms.filter((t) => t !== args?.term),
      }));
      result = vocabulary();
      break;
    case "get_cleanup_status":
      result = cleanupStatus;
      break;
    case "start_cleanup":
      settings = { ...settings, cleanupModelOk: true };
      cleanupStatus = {
        ...cleanupStatus,
        state: "downloading",
        doneBytes: 0,
        error: null,
      };
      emit("cleanup-status", cleanupStatus);
      clearInterval(cleanupDownload);
      cleanupDownload = setInterval(() => {
        cleanupStatus = {
          ...cleanupStatus,
          doneBytes: Math.min(
            cleanupStatus.totalBytes,
            cleanupStatus.doneBytes + cleanupStatus.totalBytes / 10,
          ),
        };
        if (cleanupStatus.doneBytes >= cleanupStatus.totalBytes) {
          clearInterval(cleanupDownload);
          cleanupStatus = { ...cleanupStatus, state: "ready" };
        }
        emit("cleanup-status", cleanupStatus);
      }, 300);
      break;
    case "cancel_cleanup_download":
      clearInterval(cleanupDownload);
      cleanupStatus = { ...cleanupStatus, state: "missing" };
      emit("cleanup-status", cleanupStatus);
      break;
    case "get_status":
      result = status;
      break;
    case "get_settings":
      result = settings;
      break;
    case "set_settings":
      {
        const previous = settings.cleanup;
        settings = args!.settings as Settings;
        if (previous !== settings.cleanup) {
          cleanupStatus = {
            ...cleanupStatus,
            state: settings.cleanup ? "missing" : "off",
          };
          emit("cleanup-status", cleanupStatus);
        }
      }
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
        () => emit("mic-level", 0.005 + Math.random() * 0.08),
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
      settings = { ...settings, firstRunDone: true, cleanupModelOk: true };
      status = { ...status, phase: "idle" };
      emit("status", status);
      break;
    case "start_dictation": {
      status = { ...status, phase: "recording" };
      emit("status", status);
      // Speech-like level: syllable bursts with short pauses.
      const started = performance.now();
      clearInterval(voice);
      voice = setInterval(() => {
        const t = (performance.now() - started) / 1000;
        const syllables = Math.max(0, Math.sin(t * 9) * Math.sin(t * 2.3 + 1));
        emit("mic-level", 0.002 + syllables * 0.12 + Math.random() * 0.01);
      }, 50);
      break;
    }
    case "stop_dictation": {
      if (status.phase !== "recording") break;
      clearInterval(voice);
      emit("mic-level", 0);
      status = { ...status, phase: "transcribing" };
      emit("status", status);
      setTimeout(() => {
        const entry = sampleEntry(spoken++, Date.now());
        history.unshift(entry);
        const insert =
          settings.insert === "off"
            ? { kind: "copied", reason: null }
            : { kind: "pasted" };
        emit("transcript", { entry, insert });
        status = { ...status, phase: "idle" };
        emit("status", status);
      }, 1800);
      break;
    }
  }
  return result as T;
}

// Dev-only push-to-talk: hold F8 to "dictate", or drive it from the console.
const simulate = {
  start: () => invoke("start_dictation"),
  stop: () => invoke("stop_dictation"),
  dictate: (ms = 2600) =>
    simulate
      .start()
      .then(() => new Promise((r) => setTimeout(r, ms)))
      .then(simulate.stop),
  setPhase: (phase: Status["phase"], message: string | null = null) => {
    status = { ...status, phase, message };
    emit("status", status);
  },
};
Object.assign(window, { __delulu: simulate });
window.addEventListener("keydown", (e) => {
  if (e.key === "F8" && !e.repeat) void simulate.start();
});
window.addEventListener("keyup", (e) => {
  if (e.key === "F8") void simulate.stop();
});
