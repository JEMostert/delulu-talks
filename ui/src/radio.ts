import type { Radio, RadioDirection, RadioReadiness } from "./ipc";

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
  /** Fixed in Settings → Models. */
  models?: boolean;
};

/** What Delulu FM needs, in the order to fix it. */
export function readinessSteps(r: RadioReadiness | null): ReadinessStep[] {
  if (!r) return [];
  const { music } = r;
  return [
    {
      id: "engine",
      label: "Music engine",
      ok: music.engine,
      help: "The delulu-music engine is missing from this install. Reinstall Delulu Talks.",
    },
    {
      id: "gpu",
      label: "Graphics card",
      ok: music.engine && music.gpu,
      unknown: !music.engine,
      help: music.engine
        ? "No graphics card with Vulkan was found. Songs need one; on the processor alone a song would take hours."
        : "Checked once the music engine is installed.",
    },
    {
      id: "model",
      label: "Music model (YuE2, about 4 GB)",
      ok: music.model,
      models: true,
      help: "Download it in Settings → Models. Nothing downloads until you ask.",
    },
    {
      id: "writer",
      label: "Cleanup model (writes the songs)",
      ok: r.writer,
      help: "Download the cleanup model on the Cleanup page.",
    },
    {
      id: "voice",
      label: "Host voice",
      ok: r.voice,
      optional: true,
      help: "Optional. Install the voice model in Settings → Voice replies; until then the station plays music only.",
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
      const phase = m.phase ? phases[m.phase] : null;
      const percent =
        m.progress != null ? ` · ${Math.round(m.progress * 100)}%` : "";
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
