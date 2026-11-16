import type {
  MusicModel,
  Radio,
  RadioDirection,
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
          help: "Install ACE-Step under Music engine below. Nothing downloads until you ask.",
        }
      : {
          id: "model",
          label: "Music model (YuE2, about 4 GB)",
          ok: m.model,
          models: true,
          help: "Download it in Models, or under Music engine below. Nothing downloads until you ask.",
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
      label: "Cleanup model (writes the songs)",
      ok: r.writer,
      help: "Download the cleanup model at Clean up text, on Dictate.",
    },
    {
      id: "voice",
      label: "Host voice",
      ok: r.voice,
      optional: true,
      help: "Optional. Install the voice model on the Voice page; until then the station plays music only.",
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

export const radioPresets: {
  name: string;
  direction: Partial<RadioDirection>;
}[] = [
  {
    name: "Drift",
    direction: {
      mood: "dreamlike",
      genres: ["ambient"],
      energy: "low",
      vocals: "instrumental",
    },
  },
  {
    name: "Groove",
    direction: {
      mood: "warm",
      genres: ["soul", "jazz"],
      energy: "medium",
      vocals: "either",
    },
  },
  {
    name: "Explore",
    direction: {
      mood: "curious",
      genres: ["electronic", "experimental"],
      energy: "medium",
      vocals: "either",
    },
  },
];

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
