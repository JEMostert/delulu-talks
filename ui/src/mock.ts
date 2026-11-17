import type {
  Settings,
  Status,
  HistoryEntry,
  ModelDownload,
  CleanupStatus,
  Shelf,
  Radio,
  RadioFeedback,
  RadioItem,
  RadioMix,
  MusicModel,
  MusicModelRow,
  MusicEngine,
  AceLm,
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
  allowedLanguages: ["nl", "en"],
  insert: "shift-insert",
  theme:
    (new URLSearchParams(location.search).get("theme") as Settings["theme"]) ??
    "system",
  overlay: true,
  firstRunDone: !new URLSearchParams(location.search).has("firstRun"),
  cleanup: true,
  smartContext: true,
  cleanupModelOk: true,
  radio: new URLSearchParams(location.search).has("radio"),
  historyRetentionDays: 0,
};
// Dev-only URL switches: ?firstRun, ?empty, ?phase=error|loadingModel|…,
// ?history=many (2,400 transcripts over 80 days), ?hotkey=none|error,
// ?theme=light|dark,
// ?radio&onair (Delulu FM already playing).
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
let voiceReady = params.get("voice") === "ready";
let voiceInstalling = false;
const voiceChoice = { voice: "F1", radioVoice: "M1" };
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
  hotkey:
    params.get("hotkey") === "none"
      ? { bound: false, trigger: null, error: null }
      : {
          bound: true,
          trigger: "Super+Z",
          error:
            params.get("hotkey") === "error"
              ? "The desktop refused the shortcut. Pick another key."
              : null,
        },
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
    topic: (["work", "programming", "everyday", "programming"] as const)[i % 4],
    language,
    model: settings.model,
    audioMs,
    sttMs: 180 + (i % 4) * 70,
    totalMs: 260 + (i % 5) * 90,
  };
};
let history: HistoryEntry[] = params.has("empty")
  ? []
  : params.get("history") === "many"
    ? Array.from({ length: 2400 }, (_, i) =>
        sampleEntry(i, Date.now() - 2 * 60000 - i * 48 * 60000),
      )
    : samples.map((_, i) =>
        sampleEntry(
          i,
          Date.now() - [4, 38, 190, 1500, 1700, 2900, 4400, 9000][i] * 60000,
        ),
      );

// Delulu FM: ?radio shows it; ?music=missing leaves YuE2 to download and
// ?music=cpu pretends there is no graphics card. ?engine=acestep starts on
// ACE-Step; ?ace=ready has its files installed, ?ace=warm also prepared.
const musicParam = params.get("music");
const aceParam = params.get("ace");
const aceTerms = {
  name: "MIT (text encoder: Apache-2.0)",
  url: "https://huggingface.co/Serveurperso/ACE-Step-1.5-GGUF/blob/666ac70204440867d8c01ba4b119cc79c95b370a/LICENSE",
  credit: "ACE-Step 1.5 by ACE Studio and StepFun",
  text: "ACE-Step 1.5 by ACE Studio and StepFun is released under the MIT licence. Its text encoder, Qwen3-Embedding-0.6B by the Qwen team, is licensed under Apache-2.0.\nSongs you make may be used commercially.",
};
const musicRow = (
  id: string,
  label: string,
  license: string,
  bytes: number,
  ready: boolean,
): MusicModelRow => ({
  id,
  engine: id.startsWith("yue") ? "yue" : "acestep",
  label,
  license,
  bytes,
  state: ready ? "ready" : "missing",
  terms: id.startsWith("yue") ? null : aceTerms,
});
let musicModel: MusicModel = {
  models: [
    musicRow(
      "yue2-3b-int8",
      "YuE2 3B",
      "CC BY-NC 4.0",
      3960938800,
      musicParam !== "missing",
    ),
    musicRow(
      "ace-step-1.5-turbo",
      "ACE-Step 1.5 turbo",
      "MIT, Apache-2.0",
      3671094952,
      aceParam !== null,
    ),
    musicRow(
      "ace-step-1.5-lm-0.6b",
      "ACE-Step language model 0.6B",
      "MIT",
      709846656,
      aceParam !== null,
    ),
    musicRow(
      "ace-step-1.5-lm-4b",
      "ACE-Step language model 4B",
      "MIT",
      4457323648,
      aceParam !== null,
    ),
  ],
  doneBytes: 0,
  totalBytes: 0,
  error: null,
};
const musicReady = (id: string) =>
  musicModel.models.some((m) => m.id === id && m.state === "ready");
let musicTimer: ReturnType<typeof setInterval> | undefined;
function musicUpdate(patch: Partial<MusicModel>) {
  musicModel = { ...musicModel, ...patch };
  emit("music-model", musicModel);
  radio = {
    ...radio,
    readiness: {
      ...radio.readiness!,
      music: {
        ...radio.readiness!.music,
        model: musicReady("yue2-3b-int8"),
        ace: {
          turbo: musicReady("ace-step-1.5-turbo"),
          lmSmall: musicReady("ace-step-1.5-lm-0.6b"),
          lmLarge: musicReady("ace-step-1.5-lm-4b"),
        },
      },
    },
  };
  emit("radio", radio);
}
const setRows = (ids: string[], state: MusicModelRow["state"]) =>
  musicModel.models.map((m) => (ids.includes(m.id) ? { ...m, state } : m));
const radioSong = (
  n: number,
  title: string,
  genre: string | null,
  mood: string | null = "Warm",
): RadioItem => ({
  id: `song-${n}`,
  kind: "song",
  title,
  subtitle: [mood, genre].filter(Boolean).join(" · ") || "On request",
  lyrics:
    "[Verse]\nLight on the window\nCoffee and rain\n\n[Chorus]\nCopper morning\nCall my name",
  script: null,
  seconds: 150 + n * 7,
  request: null,
  replay: false,
  imported: n > 4,
  genre,
  mood,
  surprise: false,
  feedback: null,
  saved: false,
});
// The station's catalogue and built-in stations (crates/radio/src/mix.rs).
const genreNames = [
  "Soul",
  "Jazz",
  "Lo-fi",
  "Ambient",
  "House",
  "Synthwave",
  "Indie rock",
  "Punk rock",
  "Folk",
  "Funk",
  "Hip-hop",
  "Classical",
  "Reggae",
  "Drum & bass",
  "Dutch pop",
  "Metal",
  "Country",
  "Techno",
];
const genresOn = [
  "Soul",
  "Jazz",
  "Lo-fi",
  "House",
  "Synthwave",
  "Indie rock",
  "Funk",
  "Drum & bass",
];
const moodNames = [
  "Warm",
  "Dreamlike",
  "Upbeat",
  "Melancholy",
  "Driving",
  "Playful",
  "Dark",
  "Calm",
];
const moodsOn = ["Warm", "Dreamlike", "Upbeat", "Driving", "Calm"];
const builtinStations: Record<
  string,
  { name: string; genres: string[]; moods: string[]; surprise: number } & Pick<
    RadioMix,
    "vocals" | "energy" | "lengthMinSeconds" | "lengthMaxSeconds"
  >
> = {
  drift: {
    name: "Drift",
    genres: ["Ambient", "Lo-fi", "Classical"],
    moods: ["Dreamlike", "Calm"],
    surprise: 0,
    vocals: "instrumental",
    energy: "low",
    lengthMinSeconds: 180,
    lengthMaxSeconds: 300,
  },
  groove: {
    name: "Groove",
    genres: ["Soul", "Jazz", "Funk", "House"],
    moods: ["Warm", "Upbeat"],
    surprise: 10,
    vocals: "any",
    energy: "medium",
    lengthMinSeconds: 150,
    lengthMaxSeconds: 240,
  },
  explore: {
    name: "Explore",
    genres: ["Synthwave", "Techno", "Drum & bass", "Hip-hop", "Reggae"],
    moods: ["Playful", "Driving", "Dark", "Dreamlike"],
    surprise: 35,
    vocals: "any",
    energy: "any",
    lengthMinSeconds: 120,
    lengthMaxSeconds: 270,
  },
};
type MockStation = { id: string; name: string } & ReturnType<typeof preset>;
let userStations: MockStation[] = [];
const pool = (names: string[], on: string[]) =>
  names.map((name) => ({ name, on: on.includes(name), custom: false }));
const enabled = (choices: RadioMix["genres"]) =>
  choices.filter((c) => c.on).map((c) => c.name);
const preset = (mix: RadioMix) => ({
  genres: enabled(mix.genres),
  moods: enabled(mix.moods),
  surprise: mix.surprise,
  vocals: mix.vocals,
  energy: mix.energy,
  lengthMinSeconds: mix.lengthMinSeconds,
  lengthMaxSeconds: mix.lengthMaxSeconds,
});
const presetKey = (p: ReturnType<typeof preset>) =>
  JSON.stringify({
    ...p,
    genres: [...p.genres].sort(),
    moods: [...p.moods].sort(),
  });
const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];
function withPreset(mix: RadioMix, p: ReturnType<typeof preset>): RadioMix {
  const select = (choices: RadioMix["genres"], on: string[]) => [
    ...choices.map((c) => ({ ...c, on: on.includes(c.name) })),
    ...on
      .filter((n) => !choices.some((c) => c.name === n))
      .map((name) => ({ name, on: true, custom: true })),
  ];
  return {
    ...mix,
    ...p,
    genres: select(mix.genres, p.genres),
    moods: select(mix.moods, p.moods),
  };
}
/** The stations with the one the mix sounds like marked. */
function stationList(mix: RadioMix): Radio["stations"] {
  const key = presetKey(preset(mix));
  const all = [
    ...Object.entries(builtinStations).map(([id, { name, ...p }]) => ({
      id,
      name,
      builtin: true,
      p,
    })),
    ...userStations.map(({ id, name, ...p }) => ({
      id,
      name,
      builtin: false,
      p,
    })),
  ];
  const active = all.find((s) => presetKey(s.p) === key)?.id;
  return all.map(({ id, name, builtin }) => ({
    id,
    name,
    builtin,
    active: id === active,
  }));
}
/** Pretend draw: a random enabled genre (or an off one by surprise). */
function radioDraw(): Pick<RadioItem, "genre" | "mood" | "surprise"> {
  const on = enabled(radio.mix.genres);
  const off = radio.mix.genres.filter((c) => !c.on).map((c) => c.name);
  if (radio.lock)
    return {
      genre: radio.lock.genre,
      mood: pick(enabled(radio.mix.moods)) ?? "Warm",
      surprise: false,
    };
  const surprise =
    off.length > 0 && on.length > 0 && Math.random() * 100 < radio.mix.surprise;
  const genre = pick(surprise ? off : on.length ? on : genreNames);
  return { genre, mood: pick(enabled(radio.mix.moods)) ?? "Warm", surprise };
}
let radio: Radio = {
  available: true,
  error: null,
  onAir: false,
  playing: false,
  held: false,
  volume: 0.8,
  now: null,
  position: 0,
  queue: [],
  history: [
    radioSong(5, "Orbital Echoes", "Synthwave", "Dreamlike"),
    radioSong(6, "Ghost in the Wire", "Drum & bass", "Driving"),
  ],
  making: null,
  lastError: null,
  requests: [],
  mix: {
    genres: pool(genreNames, genresOn),
    moods: pool(moodNames, moodsOn),
    surprise: 15,
    vocals: "any",
    energy: "any",
    lengthMinSeconds: 120,
    lengthMaxSeconds: 270,
    host: "sometimes",
    language: "English",
    theme: "",
  },
  stations: [],
  saved: [],
  lock: null,
  lockSongs: 5,
  weights: {},
  lengthLimits: { min: 60, max: 300 },
  lastSongSeconds: null,
  lastSongAudioSeconds: null,
  readiness: {
    music: {
      engine: true,
      model: musicParam !== "missing",
      ace: {
        turbo: aceParam !== null,
        lmSmall: aceParam !== null,
        lmLarge: aceParam !== null,
      },
      device:
        musicParam === "cpu" ? "CPU" : "Vulkan0 (NVIDIA GeForce RTX 5060 Ti)",
      gpu: musicParam !== "cpu",
    },
    writer: true,
    voice: params.get("voice") === "ready",
  },
  music: {
    engine: params.get("engine") === "acestep" ? "acestep" : "yue2",
    aceLm: "auto",
    aceWarm: aceParam === "warm" ? "delulu-engine mock" : undefined,
  },
};
radio.stations = stationList(radio.mix);
let radioSongs = 0;
let radioMaking: ReturnType<typeof setTimeout> | undefined;
const radioReady = () => {
  const m = radio.readiness!.music;
  const model =
    radio.music.engine === "acestep"
      ? m.ace.turbo && (m.ace.lmSmall || m.ace.lmLarge)
      : m.model;
  return m.engine && m.gpu && model;
};
function radioUpdate(patch: Partial<Radio>) {
  radio = { ...radio, ...patch };
  const savedIds = new Set(radio.saved.map((i) => i.title));
  const mark = (i: RadioItem) => ({ ...i, saved: savedIds.has(i.title) });
  radio = {
    ...radio,
    stations: stationList(radio.mix),
    now: radio.now && mark(radio.now),
    queue: radio.queue.map(mark),
    history: radio.history.map(mark),
  };
  emit("radio", radio);
}
/** Every item, for lookups by id. */
const radioItems = () => [
  ...(radio.now ? [radio.now] : []),
  ...radio.queue,
  ...radio.history,
  ...radio.saved,
];
function radioSetFeedback(id: string, feedback: RadioFeedback | null) {
  const item = radioItems().find((i) => i.id === id);
  if (!item) throw "That song is no longer on the station.";
  const factor = (f: RadioFeedback | null) =>
    f === "like" ? 1.5 : f === "dislike" ? 1 / 1.5 : 1;
  const weights = { ...radio.weights };
  if (item.genre) {
    const key = item.genre.toLowerCase();
    const w = (weights[key] ?? 1) * (factor(feedback) / factor(item.feedback));
    weights[key] = Math.min(4, Math.max(0.25, w));
    if (Math.abs(weights[key] - 1) < 0.01) delete weights[key];
  }
  const set = (i: RadioItem) =>
    i.title === item.title ? { ...i, feedback } : i;
  radioUpdate({
    weights,
    now: radio.now && set(radio.now),
    queue: radio.queue.map(set),
    history: radio.history.map(set),
    saved: radio.saved.map(set),
  });
}
/** Pretend production: a song is written, then composed, then ready. */
function radioProduce() {
  if (!radio.onAir || radio.making || radio.queue.length >= 2 || !radioReady())
    return;
  const n = ++radioSongs;
  const request = radio.requests.find((r) => !r.answeredBy);
  const drawn = request
    ? { genre: null, mood: null, surprise: false }
    : radioDraw();
  radioUpdate({
    making: {
      kind: "song",
      step: "writing",
      title: null,
      request: request?.text ?? null,
      since: Date.now(),
      progress: null,
      phase: null,
      preparing: false,
      ...drawn,
    },
  });
  radioMaking = setTimeout(() => {
    radioUpdate({
      making: {
        kind: "song",
        step: "music",
        title: `Song ${n}`,
        request: request?.text ?? null,
        since: Date.now(),
        // ACE-Step's first song waits for the shaders.
        ...(radio.music.engine === "acestep" && !radio.music.aceWarm
          ? { progress: null, phase: "loading" as const, preparing: true }
          : { progress: 0.54, phase: "shaping" as const, preparing: false }),
        ...drawn,
      },
    });
    radioMaking = setTimeout(() => {
      const song = {
        ...radioSong(n, `Song ${n}`, drawn.genre, drawn.mood),
        surprise: drawn.surprise,
        request: request?.text ?? null,
      };
      const lock = radio.lock;
      if (lock?.left != null)
        radio.lock = lock.left > 1 ? { ...lock, left: lock.left - 1 } : null;
      radioUpdate({
        making: null,
        music:
          radio.music.engine === "acestep"
            ? { ...radio.music, aceWarm: "delulu-engine mock" }
            : radio.music,
        queue: [...radio.queue, song],
        requests: radio.requests.map((r) =>
          r.id === request?.id ? { ...r, answeredBy: song.title } : r,
        ),
      });
      if (radio.playing && !radio.now) radioAdvance();
      radioProduce();
    }, 2500);
  }, 1200);
}
function radioAdvance() {
  const history =
    radio.now && !radio.now.replay
      ? [radio.now, ...radio.history]
      : radio.history;
  const [next, ...queue] = radio.queue;
  const replay = history.find(
    (i) => i.kind === "song" && i.id !== radio.now?.id,
  );
  radioUpdate({
    history,
    queue,
    now:
      next ??
      (replay ? { ...replay, id: `replay-${Date.now()}`, replay: true } : null),
    position: 0,
  });
  radioProduce();
}
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
    case "get_voice_status":
      if (params.get("voice") === "error")
        throw "Voice replies are unavailable. Install the delulu command in ~/.local/bin or on your PATH, then reopen Settings.";
      result = {
        ready: voiceReady,
        installing: voiceInstalling,
        model: voiceReady,
        engine: true,
        ...voiceChoice,
        voices: ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"],
        modelLabel: "Supertonic 3",
        modelBytes: 401291751,
        terms: {
          name: "BigScience OpenRAIL-M",
          url: "https://huggingface.co/Supertone/supertonic-3/blob/3cadd1ee6394adea1bd021217a0e650ede09a323/LICENSE",
          credit: "Supertonic 3 by Supertone Inc.",
          text: "Supertonic 3 by Supertone Inc. is licensed under the BigScience OpenRAIL-M licence. By downloading and using it you agree to its use restrictions (Attachment A). You agree not to use the model:\n(a) in any way that violates any applicable law or regulation;\n…\nThe voices are machine generated; say so wherever you share their audio.",
        },
      };
      break;
    case "set_voice":
      if (args?.role === "radio") voiceChoice.radioVoice = String(args?.voice);
      else voiceChoice.voice = String(args?.voice);
      break;
    case "install_voice_model":
      voiceInstalling = true;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      voiceInstalling = false;
      if (params.get("voice") === "install-error")
        throw "Could not download the model. Check your connection and try again.";
      voiceReady = true;
      break;
    case "get_music_model":
      result = musicModel;
      break;
    case "download_music_model": {
      const ids = ((args?.ids as string[]) ?? []).filter(
        (id) => !musicReady(id),
      );
      const busy = musicModel.models.some((m) => m.state === "downloading");
      if (ids.length && !busy) {
        const total = musicModel.models
          .filter((m) => ids.includes(m.id))
          .reduce((sum, m) => sum + m.bytes, 0);
        musicUpdate({
          models: setRows(ids, "downloading"),
          doneBytes: 0,
          totalBytes: total,
          error: null,
        });
        musicTimer = setInterval(() => {
          const done = musicModel.doneBytes + 800_000_000;
          if (done >= musicModel.totalBytes) {
            clearInterval(musicTimer);
            musicUpdate({
              models: setRows(ids, "ready"),
              doneBytes: 0,
              totalBytes: 0,
            });
          } else musicUpdate({ doneBytes: done });
        }, 400);
      }
      result = musicModel;
      break;
    }
    case "cancel_music_download":
      clearInterval(musicTimer);
      musicUpdate({
        models: musicModel.models.map((m) =>
          m.state === "downloading" ? { ...m, state: "missing" } : m,
        ),
        doneBytes: 0,
        totalBytes: 0,
      });
      break;
    case "delete_music_model":
      musicUpdate({ models: setRows([args?.id as string], "missing") });
      result = musicModel;
      break;
    case "radio_music":
      radioUpdate({
        music: {
          ...radio.music,
          engine: args?.engine as MusicEngine,
          aceLm: args?.aceLm as AceLm,
        },
      });
      radioProduce();
      result = radio;
      break;
    case "get_radio":
    case "check_radio":
      result = radio;
      break;
    case "radio_play":
      if (!settings.radio) throw "Turn on Delulu FM in Settings first.";
      radioUpdate({ onAir: true, playing: true });
      if (!radio.now) radioAdvance();
      radioProduce();
      result = radio;
      break;
    case "radio_pause":
      radioUpdate({ playing: false });
      result = radio;
      break;
    case "radio_off":
      clearTimeout(radioMaking);
      radioUpdate({ onAir: false, playing: false, making: null });
      result = radio;
      break;
    case "radio_skip":
      radioAdvance();
      result = radio;
      break;
    case "radio_volume":
      radio = { ...radio, volume: args?.volume as number };
      break;
    case "radio_mix":
      radioUpdate({ mix: args?.mix as RadioMix });
      result = radio;
      break;
    case "radio_shuffle": {
      const roll = (choices: RadioMix["genres"], p: number) => {
        const next = choices.map((c) => ({ ...c, on: Math.random() < p }));
        if (!next.some((c) => c.on)) next[0].on = true;
        return next;
      };
      radioUpdate({
        mix: {
          ...radio.mix,
          genres: roll(radio.mix.genres, 0.3),
          moods: roll(radio.mix.moods, 0.4),
          surprise: Math.floor(Math.random() * 9) * 5,
        },
      });
      result = radio;
      break;
    }
    case "radio_station_save": {
      const name = String(args?.name ?? "")
        .trim()
        .slice(0, 24);
      if (!name) throw "Give the station a name.";
      if (
        Object.values(builtinStations).some(
          (b) => b.name.toLowerCase() === name.toLowerCase(),
        )
      )
        throw `${name} is a built-in station. Pick another name.`;
      const existing = userStations.find(
        (s) => s.name.toLowerCase() === name.toLowerCase(),
      );
      const id = existing?.id ?? crypto.randomUUID().slice(0, 12);
      userStations = [
        ...userStations.filter((s) => s.id !== id),
        { id, name, ...preset(radio.mix) },
      ];
      radioUpdate({});
      result = radio;
      break;
    }
    case "radio_station_rename": {
      const id = String(args?.id);
      if (id in builtinStations) throw "Built-in stations keep their name.";
      const name = String(args?.name ?? "")
        .trim()
        .slice(0, 24);
      if (!name) throw "Give the station a name.";
      userStations = userStations.map((s) =>
        s.id === id ? { ...s, name } : s,
      );
      radioUpdate({});
      result = radio;
      break;
    }
    case "radio_station_delete": {
      const id = String(args?.id);
      if (id in builtinStations) throw "Built-in stations cannot be deleted.";
      userStations = userStations.filter((s) => s.id !== id);
      radioUpdate({});
      result = radio;
      break;
    }
    case "radio_station_activate": {
      const id = String(args?.id);
      const found =
        builtinStations[id] ?? userStations.find((s) => s.id === id);
      if (!found) throw "That station no longer exists.";
      radioUpdate({
        mix: withPreset(radio.mix, {
          genres: found.genres,
          moods: found.moods,
          surprise: found.surprise,
          vocals: found.vocals,
          energy: found.energy,
          lengthMinSeconds: found.lengthMinSeconds,
          lengthMaxSeconds: found.lengthMaxSeconds,
        }),
      });
      result = radio;
      break;
    }
    case "radio_feedback": {
      const id = String(args?.id);
      const feedback = (args?.feedback ?? null) as RadioFeedback | null;
      radioSetFeedback(id, feedback);
      if (feedback === "dislike" && radio.now?.id === id) radioAdvance();
      result = radio;
      break;
    }
    case "radio_reset_feedback": {
      const genre = (args?.genre as string | null) ?? null;
      const clear = (i: RadioItem) =>
        !genre || i.genre?.toLowerCase() === genre.toLowerCase()
          ? { ...i, feedback: null }
          : i;
      const weights = genre
        ? Object.fromEntries(
            Object.entries(radio.weights).filter(
              ([g]) => g !== genre.toLowerCase(),
            ),
          )
        : {};
      radioUpdate({
        weights,
        now: radio.now && clear(radio.now),
        queue: radio.queue.map(clear),
        history: radio.history.map(clear),
        saved: radio.saved.map(clear),
      });
      result = radio;
      break;
    }
    case "radio_lock": {
      const genre = radio.now?.genre;
      if (!genre) throw "This song has no genre to stay on.";
      const songs = args?.songs as number | null | undefined;
      radioUpdate({
        lock: { genre, left: songs === 0 ? null : (songs ?? radio.lockSongs) },
      });
      result = radio;
      break;
    }
    case "radio_unlock":
      radioUpdate({ lock: null });
      result = radio;
      break;
    case "radio_save": {
      const item = radioItems().find((i) => i.id === args?.id);
      if (!item || item.kind !== "song") throw "Only songs can be saved.";
      if (!radio.saved.some((i) => i.title === item.title))
        radioUpdate({
          saved: [{ ...item, replay: false, saved: true }, ...radio.saved],
        });
      result = radio;
      break;
    }
    case "radio_unsave": {
      const item = radioItems().find((i) => i.id === args?.id);
      radioUpdate({
        saved: radio.saved.filter(
          (i) => i.id !== args?.id && i.title !== item?.title,
        ),
      });
      result = radio;
      break;
    }
    case "radio_play_saved": {
      if (!settings.radio) throw "Turn on Delulu FM in Settings first.";
      const item = radio.saved.find((i) => i.id === args?.id);
      if (!item) throw "That song is no longer saved.";
      const history =
        radio.now && !radio.now.replay
          ? [radio.now, ...radio.history]
          : radio.history;
      radioUpdate({
        onAir: true,
        playing: true,
        history,
        now: { ...item, id: `replay-${Date.now()}`, replay: true },
        position: 0,
      });
      radioProduce();
      result = radio;
      break;
    }
    case "radio_request": {
      const text = String(args?.text ?? "").trim();
      if (!text) throw "Type what you would like to hear.";
      if (radio.requests.filter((r) => !r.answeredBy).length >= 3)
        throw "Three requests are already waiting. Try again after the next song.";
      radioUpdate({
        requests: [
          ...radio.requests,
          { id: crypto.randomUUID(), text, createdAt: Date.now() },
        ].slice(-4),
      });
      radioProduce();
      result = radio;
      break;
    }
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
        { code: "de", name: "german" },
        { code: "fr", name: "french" },
        { code: "nl", name: "dutch" },
        { code: "is", name: "icelandic" },
      ];
      break;
    case "list_models":
      result = [
        {
          id: "large-v3-turbo-q5_0",
          label: "Large v3 Turbo (recommended)",
          engine: "whisper",
          bytes: 574041195,
          downloaded: downloaded.has("large-v3-turbo-q5_0"),
          license: "MIT",
          credit: null,
          licenseUrl: null,
          replaces: null,
        },
        {
          id: "small",
          label: "Small (faster, weaker Dutch)",
          engine: "whisper",
          bytes: 487601967,
          downloaded: downloaded.has("small"),
          license: "MIT",
          credit: null,
          licenseUrl: null,
          replaces: null,
        },
        {
          id: "parakeet-ultra-q8_0",
          label: "Parakeet Ultra",
          engine: "parakeet",
          bytes: 740382222,
          downloaded: downloaded.has("parakeet-ultra-q8_0"),
          license: "CC BY 4.0",
          credit:
            "Parakeet Ultra by Moondream, post-trained from NVIDIA Parakeet TDT 0.6B v3",
          licenseUrl:
            "https://huggingface.co/handy-computer/parakeet-ultra-gguf/blob/a1539be1b849ea7463b88343e5277b373d0c4ea9/LICENSE",
          replaces: null,
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
  /** A dictation that could neither be pasted nor copied. */
  failInsert: () => {
    const entry = sampleEntry(spoken++, Date.now());
    history.unshift(entry);
    emit("transcript", {
      entry,
      insert: { kind: "failed", reason: "the clipboard is not available" },
    });
  },
};
if (params.has("onair") && settings.radio) void invoke("radio_play");
Object.assign(window, { __delulu: simulate });
window.addEventListener("keydown", (e) => {
  if (e.key === "F8" && !e.repeat) void simulate.start();
});
window.addEventListener("keyup", (e) => {
  if (e.key === "F8") void simulate.stop();
});
