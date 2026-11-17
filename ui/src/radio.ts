import type {
  MusicModel,
  Radio,
  RadioMix,
  RadioMusic,
  RadioReadiness,
} from "./ipc";

/** m:ss */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export type ReadinessStep = {
  id: string;
  label: string;
  ok: boolean;
  help: string;
  /** The station runs without it. */
  optional?: boolean;
  /** Can't be checked yet, so not shown as a problem. */
  unknown?: boolean;
  /** Fixed on the Models page. */
  models?: boolean;
  /** Fixed on the Voice page. */
  voice?: boolean;
};

/** ACE-Step's files are all here for this language-model choice; on auto either
 * language model will do. */
export function aceReady(
  ace: RadioReadiness["music"]["ace"],
  aceLm: RadioMusic["aceLm"],
): boolean {
  if (!ace.turbo) return false;
  if (aceLm === "0.6b") return ace.lmSmall;
  if (aceLm === "4b") return ace.lmLarge;
  return ace.lmSmall || ace.lmLarge;
}

/** The registry models that installing an engine downloads. On auto both of
 * ACE-Step's language models come, so it can pick by free graphics memory. */
export function engineModels(music: RadioMusic): string[] {
  if (music.engine === "yue2") return ["yue2-3b-int8"];
  const lms = {
    auto: ["ace-step-1.5-lm-0.6b", "ace-step-1.5-lm-4b"],
    "0.6b": ["ace-step-1.5-lm-0.6b"],
    "4b": ["ace-step-1.5-lm-4b"],
  }[music.aceLm];
  return ["ace-step-1.5-turbo", ...lms];
}

/** Bytes still to download for these models. */
export function missingBytes(models: MusicModel | null, ids: string[]): number {
  return (models?.models ?? [])
    .filter((m) => ids.includes(m.id) && m.state !== "ready")
    .reduce((sum, m) => sum + m.bytes, 0);
}

/** What Delulu FM needs, in the order to fix it. */
export function readinessSteps(
  r: RadioReadiness | null,
  music: RadioMusic = { engine: "yue2", aceLm: "auto" },
): ReadinessStep[] {
  if (!r) return [];
  const { music: m } = r;
  const modelStep: ReadinessStep =
    music.engine === "acestep"
      ? {
          id: "model",
          label: "Music model (ACE-Step 1.5)",
          ok: aceReady(m.ace, music.aceLm),
          models: true,
          help: "Install ACE-Step on the Models page. Nothing downloads until you ask.",
        }
      : {
          id: "model",
          label: "Music model (YuE2, about 4 GB)",
          ok: m.model,
          models: true,
          help: "Download YuE2 on the Models page. Nothing downloads until you ask.",
        };
  return [
    {
      id: "engine",
      label: "Music engine",
      ok: m.engine,
      help: "The music engine (delulu-engine) is missing from this install. Reinstall Delulu Talks.",
    },
    {
      id: "gpu",
      label: "Graphics card",
      ok: m.engine && m.gpu,
      unknown: !m.engine,
      help: m.engine
        ? "No graphics card with Vulkan was found. Songs need one; on the processor alone a song would take hours."
        : "Checked once the music engine is installed.",
    },
    modelStep,
    {
      id: "writer",
      label: "Song writer (cleanup model)",
      ok: r.writer,
      help: "Download the cleanup model at Clean up text, on Dictate.",
    },
    {
      id: "voice",
      label: "Host voice",
      ok: r.voice,
      optional: true,
      help: "Optional. Install the voice model on the Voice page; until then the station plays music only.",
      voice: true,
    },
  ];
}

const phases: Record<string, string> = {
  loading: "loading the model",
  score: "writing the score",
  composing: "composing",
  shaping: "shaping the sound",
  rendering: "rendering",
};

/** What production is doing, for the status line. */
export function makingText(radio: Radio, now: number): string | null {
  const m = radio.making;
  if (!m) return null;
  const since = Math.max(0, Math.round((now - m.since) / 1000));
  const title = m.title ? `“${m.title}”` : "";
  switch (m.step) {
    case "writing":
      return m.kind === "break"
        ? "Writing what the host says…"
        : m.request
          ? `Writing a song for your request…`
          : "Writing the next song…";
    case "music": {
      const percent =
        m.progress != null && m.progress > 0
          ? ` · ${Math.round(m.progress * 100)}%`
          : "";
      // The driver compiles ACE-Step's shaders on its first song: minutes with
      // little progress, so say so and keep a clock running.
      if (m.preparing)
        return `Making ${title}: preparing the graphics card for ACE-Step, once (a few minutes)${percent} · ${clock(since)}`;
      const phase = m.phase ? phases[m.phase] : null;
      // Before the first progress: a clock, so a slow start does not look stuck.
      if (m.phase === "loading" && !percent)
        return `Making ${title}: ${phase} · ${since} s`;
      return phase
        ? `Making ${title}: ${phase}${percent}`
        : `Making ${title} · ${since} s`;
    }
    case "voice":
      return `Recording the host · ${since} s`;
  }
}

export type LyricSection = { tag: string | null; lines: string[] };

/** Lyrics as sections of single lines. Older items could hold a tag run into a
 * line ("…tutu.[Chorus]"), so every tag is split onto its own line first. */
export function lyricSections(text: string): LyricSection[] {
  const sections: LyricSection[] = [];
  let open = false;
  const lines = text
    .replace(/[ \t]*(\[[^[\]\n]{1,60}\])[ \t]*/g, "\n$1\n")
    .split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    const tag = /^\[(.+)\]$/.exec(line);
    const last = sections[sections.length - 1];
    if (tag) {
      sections.push({ tag: tag[1].trim(), lines: [] });
      open = true;
    } else if (!line) {
      // A blank line ends an untagged stanza; a tagged section runs to the next tag.
      if (last?.tag === null) open = false;
    } else if (open && last) {
      last.lines.push(line);
    } else {
      sections.push({ tag: null, lines: [line] });
      open = true;
    }
  }
  return sections;
}

/** Whether there is anything to sing; an instrumental keeps only its form. */
export function hasWords(sections: LyricSection[]): boolean {
  return sections.some((s) => s.lines.length > 0);
}

/** What production is doing, in a few words for the deck; `makingText` has
 * the whole sentence for its tooltip. */
export function makingShort(radio: Radio, now: number): string | null {
  const m = radio.making;
  if (!m) return null;
  const since = Math.max(0, Math.round((now - m.since) / 1000));
  if (m.kind === "break")
    return m.step === "voice"
      ? `Recording the host · ${since} s`
      : "Writing the host’s lines";
  if (m.step === "writing")
    return m.request ? "Writing your request" : "Writing the next song";
  if (m.preparing) return `Preparing the graphics card · ${clock(since)}`;
  if (m.progress != null && m.progress > 0)
    return `Making the next song · ${Math.round(m.progress * 100)}%`;
  return `Making the next song · ${clock(since)}`;
}

/** The mockup's palette for the catalogue genres; a listener's own genre gets
 * a colour from its name, so it keeps it. */
const genreColors: Record<string, string> = {
  soul: "#ffb3c1",
  jazz: "#f6c979",
  "lo-fi": "#c2addb",
  ambient: "#75e4ff",
  house: "#5fdcbf",
  synthwave: "#ff6f86",
  "indie rock": "#f6dfb0",
  "punk rock": "#ff8a9e",
  folk: "#c4f2e6",
  funk: "#ffc2d1",
  "hip-hop": "#d9c9f2",
  classical: "#bfefff",
  reggae: "#9be08f",
  "drum & bass": "#8fb7ff",
  "dutch pop": "#ffcf8a",
  metal: "#b8c4d0",
  country: "#e8c39a",
  techno: "#7fe0e0",
};
const spare = [
  "#ffb3c1",
  "#75e4ff",
  "#5fdcbf",
  "#f6c979",
  "#c2addb",
  "#9be08f",
  "#8fb7ff",
  "#ffcf8a",
];

export function genreColor(name: string): string {
  const key = name.toLowerCase();
  if (genreColors[key]) return genreColors[key];
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return spare[h % spare.length];
}

/** A genre's draw weight from likes and dislikes, 1 when it has none. */
export function genreWeight(radio: Radio, genre: string): number {
  return radio.weights[genre.toLowerCase()] ?? 1;
}

/** "F1" → "Female 1", "M3" → "Male 3". */
export function voiceName(voice: string): string {
  return `${voice.startsWith("F") ? "Female" : "Male"} ${voice.slice(1)}`;
}

/**
 * Sends mix edits one write at a time. Each write sends the newest edit, so a
 * burst of edits ends with the latest one on the station, and a station
 * command runs only after every edit before it is written. A failed write
 * keeps its edit for the next write, unless a newer edit replaced it.
 */
export class MixWriter {
  private unsent: RadioMix | null = null;
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;

  constructor(private readonly send: (mix: RadioMix) => Promise<Radio>) {}

  /** Keep `mix` as the newest edit; the next flush sends it. */
  edit(mix: RadioMix) {
    this.unsent = mix;
  }

  /** An edit waits or a write or command is still running or queued. */
  get busy(): boolean {
    return this.unsent !== null || this.queued > 0;
  }

  /** Send the newest edit after the writes before it. Null when none was
   * waiting; rejects when the write failed. */
  flush(): Promise<Radio | null> {
    return this.enqueue(() => this.write());
  }

  /** Write any waiting edit, then run `call`; not run when that write fails. */
  run<T>(call: () => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      await this.write();
      return call();
    });
  }

  private async write(): Promise<Radio | null> {
    const mix = this.unsent;
    if (!mix) return null;
    this.unsent = null;
    try {
      return await this.send(mix);
    } catch (e) {
      this.unsent ??= mix;
      throw e;
    }
  }

  private enqueue<T>(step: () => Promise<T>): Promise<T> {
    this.queued++;
    const result = this.tail.then(step).finally(() => {
      this.queued--;
    });
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
