import { Play, Upload, UserRound } from "lucide-react";
import { SettingRow } from "../ui";
import type { VoiceControls } from "../../hooks/useVoice";
import { KOKORO_VOICES, type VoiceOption } from "../../voice";
import type { AppSettings } from "../../types";

const GROUPS: Array<[string, (voice: VoiceOption) => boolean]> = [
  [
    "American · female",
    (v) => v.accent === "American" && v.gender === "female",
  ],
  ["American · male", (v) => v.accent === "American" && v.gender === "male"],
  ["British · female", (v) => v.accent === "British" && v.gender === "female"],
  ["British · male", (v) => v.accent === "British" && v.gender === "male"],
];

/** Kokoro's speakers, or Chatterbox's own voice and an optional voice clip. */
export function VoiceSpeaker({
  settings: s,
  voice,
  saving,
  unavailableReason,
  onSave,
  onAction,
}: {
  settings: AppSettings;
  voice: VoiceControls;
  saving: boolean;
  /** Why Preview is disabled; empty when speech can run. */
  unavailableReason: string;
  onSave: (
    patch: Partial<AppSettings>,
    message?: string | null,
  ) => Promise<boolean>;
  onAction: (run: () => Promise<unknown>, success?: string) => Promise<boolean>;
}) {
  const kokoro = s.voiceEngine === "kokoro";
  const preview = () =>
    void onAction(async () => {
      const name = kokoro
        ? (KOKORO_VOICES.find((item) => item.id === s.voiceName)?.label ??
          "Kokoro")
        : s.voiceClone
          ? "your voice clip"
          : "Chatterbox";
      const result = await voice.speak({
        text: kokoro
          ? `Hi, I'm ${name}. This is how I sound.`
          : `Hi, this is ${name}. [chuckle] This is how I sound.`,
        source: "app",
        interrupt: true,
      });
      if (result.outcome === "failed")
        throw new Error(result.error ?? "The preview could not be spoken.");
    });
  const previewButton = (
    <button
      className="secondary-button"
      disabled={!!unavailableReason || saving}
      title={unavailableReason || "Hear this voice"}
      onClick={preview}
    >
      <Play /> Preview
    </button>
  );

  if (kokoro)
    return (
      <SettingRow icon={UserRound} title="Speaker">
        <select
          aria-label="Speaker"
          value={s.voiceName}
          disabled={saving}
          onChange={(event) => void onSave({ voiceName: event.target.value })}
        >
          {GROUPS.map(([label, matches]) => (
            <optgroup key={label} label={label}>
              {KOKORO_VOICES.filter(matches).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {previewButton}
      </SettingRow>
    );

  return (
    <SettingRow
      icon={UserRound}
      title="Speaker"
      description={
        s.voiceClone ? `Cloned from ${s.voiceClone}` : "Chatterbox's own voice"
      }
      help="Use a clip of 5–20 seconds of one person speaking clearly, with no music or other voices. Only clone a voice you have permission to use."
    >
      {s.voiceClone && (
        <button
          className="tool-button"
          disabled={saving}
          onClick={() =>
            void onAction(async () => {
              const next = await voice.removeReference();
              await onSave(
                { voiceClone: next.voiceClone },
                "Using the built-in voice",
              );
            })
          }
        >
          Use built-in
        </button>
      )}
      <button
        className="secondary-button"
        disabled={saving}
        onClick={() =>
          void onAction(async () => {
            const next = await voice.chooseReference();
            // Sync the local copy; the desktop has already saved it.
            if (next)
              await onSave({ voiceClone: next.voiceClone }, "Voice clip saved");
          })
        }
      >
        <Upload /> {s.voiceClone ? "Replace clip" : "Clone a voice…"}
      </button>
      {previewButton}
    </SettingRow>
  );
}
