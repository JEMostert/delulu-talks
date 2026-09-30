import type { MagicPreset } from "./types";

export const REWRITE_PRESETS: ReadonlyArray<{
  id: MagicPreset;
  label: string;
  description: string;
  exampleSource: string;
  exampleOutput: string;
}> = [
  {
    id: "summary",
    label: "Summary",
    description: "Summarize the preserved recognition original. Review it first; summaries omit detail and recognition errors can carry through.",
    exampleSource: "We reviewed the draft. The budget is not approved yet. Eva will send the revised numbers on Friday, if finance confirms them.",
    exampleOutput: "The draft was reviewed, but the budget remains unapproved. Eva may send revised numbers on Friday, pending finance confirmation.",
  },
  {
    id: "concise",
    label: "Shorten",
    description: "Remove repetition and filler while keeping facts, requests and uncertainty.",
    exampleSource: "I just wanted to say that the meeting is at 10 on Friday, and please bring the draft with you.",
    exampleOutput: "The meeting is at 10 on Friday. Please bring the draft.",
  },
  {
    id: "polish",
    label: "Polish",
    description: "Clean up grammar and speech artifacts, keeping your tone and detail.",
    exampleSource: "so I checked the draft and um the second paragraph needs a clearer example",
    exampleOutput: "I checked the draft, and the second paragraph needs a clearer example.",
  },
  {
    id: "bullet-points",
    label: "Bullet points",
    description: "Turn the existing points into concise bullets without adding tasks or priorities.",
    exampleSource: "The draft is ready. We still need to review the budget, and the launch might move to Friday.",
    exampleOutput: "- The draft is ready.\n- We still need to review the budget.\n- The launch might move to Friday.",
  },
  {
    id: "professional-message",
    label: "Professional message",
    description: "Write a brief, courteous message without inventing recipients or commitments.",
    exampleSource: "hey could you send me the revised draft by Friday I need it for the review",
    exampleOutput: "Could you please send me the revised draft by Friday? I need it for the review.",
  },
  {
    id: "structured",
    label: "Organize",
    description: "Group existing details under useful headings or bullets.",
    exampleSource: "The draft is ready. The budget still needs a review.",
    exampleOutput: "Status\n- The draft is ready.\n\nNext step\n- Review the budget.",
  },
  {
    id: "prompt",
    label: "Build a prompt",
    description: "Arrange the stated goal and constraints into a prompt.",
    exampleSource: "Write a short summary of the draft. Keep the dates unchanged.",
    exampleOutput: "Summarize the draft briefly. Preserve all dates exactly.",
  },
];

export function isMagicPreset(value: unknown): value is MagicPreset {
  return typeof value === "string" && REWRITE_PRESETS.some((preset) => preset.id === value);
}

export function isAutomaticMagicPreset(value: unknown): value is Exclude<MagicPreset, "summary"> {
  return value !== "summary" && isMagicPreset(value);
}

export const AUTOMATIC_REWRITE_PRESETS = REWRITE_PRESETS.filter((preset) => preset.id !== "summary");
