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
  /** Can't be checked yet (ComfyUI is not running), so not shown as a problem. */
  unknown?: boolean;
};

/** What LLM FM needs, in the order to fix it. */
export function readinessSteps(r: RadioReadiness | null): ReadinessStep[] {
  if (!r) return [];
  const { comfy } = r;
  return [
    {
      id: "cli",
      label: "Comfy CLI",
      ok: comfy.cli,
      help: "Install the comfy command (comfy-cli) and make sure it is on your PATH.",
    },
    {
      id: "server",
      label: "ComfyUI running",
      ok: comfy.server,
      help: `Start your ComfyUI, for example with comfy launch --background. Looking at ${comfy.url}.`,
    },
    {
      id: "nodes",
      label: "YuE2 in ComfyUI",
      ok: comfy.server && comfy.nodes,
      unknown: !comfy.server,
      help: comfy.server
        ? "Update ComfyUI to a version with the native YuE2 nodes, then restart it."
        : "Checked once ComfyUI is running.",
    },
    {
      id: "checkpoint",
      label: "YuE2 model",
      ok: comfy.server && comfy.checkpoint,
      unknown: !comfy.server,
      help: comfy.server
        ? "Install the YuE2 checkpoint into ComfyUI with the Comfy CLI command below."
        : "Checked once ComfyUI is running.",
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
    case "music":
      return `Composing ${title} in ComfyUI · ${since} s`;
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
