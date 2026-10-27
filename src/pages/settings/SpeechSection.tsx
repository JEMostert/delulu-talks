import { AudioWaveform } from "lucide-react";
import { NumberField, SettingRow } from "../../components/ui";
import { SpeechTierPicker } from "../../components/models/SpeechTierPicker";
import type { AppSettings } from "../../types";
import { Group, SettingToggle, type SectionProps } from "./shared";

const IDLE_MINUTES = [1, 5, 15, 30, 60];

export function SpeechSection({
  largeSpeechAvailable,
  ...section
}: SectionProps & { largeSpeechAvailable: boolean }) {
  const { settings: s, saving, busy, save } = section;
  return (
    <>
      <Group title="Engine">
        <SpeechTierPicker
          settings={s}
          largeAvailable={largeSpeechAvailable}
          disabled={saving || busy}
          onSelect={save}
        />
        <SettingRow title="Keep ready" description="Uses memory while idle.">
          <SettingToggle
            {...section}
            name="preloadModel"
            label="Keep the speech engine ready"
            disabled={busy}
          />
        </SettingRow>
        <SettingRow title="Unload when idle">
          <select
            aria-label="Idle unload delay"
            value={s.modelIdleMinutes}
            disabled={saving}
            onChange={(e) => save({ modelIdleMinutes: Number(e.target.value) })}
          >
            {IDLE_MINUTES.map((n) => (
              <option value={n} key={n}>
                After {n} {n === 1 ? "minute" : "minutes"}
              </option>
            ))}
          </select>
        </SettingRow>
      </Group>

      <Group title="While you speak">
        <SettingRow icon={AudioWaveform} title="Stop after silence">
          <SettingToggle
            {...section}
            name="trailingSilenceStopEnabled"
            label="Stop after silence"
            disabled={busy}
          />
        </SettingRow>
        {s.trailingSilenceStopEnabled && (
          <>
            <SettingRow title="Silence length (seconds)">
              <NumberField
                label="Silence duration in seconds"
                min={2}
                max={30}
                value={s.trailingSilenceSeconds}
                disabled={busy}
                onCommit={(trailingSilenceSeconds) =>
                  save({ trailingSilenceSeconds })
                }
              />
            </SettingRow>
            <SettingRow
              title="Silence level (dB)"
              description="Anything quieter counts as silence."
            >
              <NumberField
                label="Silence threshold in dB"
                min={-60}
                max={-20}
                value={s.trailingSilenceThresholdDb}
                disabled={busy}
                onCommit={(trailingSilenceThresholdDb) =>
                  save({ trailingSilenceThresholdDb })
                }
              />
            </SettingRow>
          </>
        )}
      </Group>

      <Group title="Formatting">
        <SettingRow
          title="Punctuation"
          description="Spoken: say “insert comma”. English and Dutch."
        >
          <select
            aria-label="Dictation formatting"
            value={s.dictationFormatting ?? "preserve"}
            disabled={saving || busy}
            onChange={(e) =>
              save({
                dictationFormatting: e.target
                  .value as AppSettings["dictationFormatting"],
              })
            }
          >
            <option value="preserve">Recognized</option>
            <option value="spoken">Spoken</option>
          </select>
        </SettingRow>
        <SettingRow
          title="Line commands"
          description="Say “command new line” or “commando nieuwe alinea”."
        >
          <SettingToggle
            {...section}
            name="spokenFormattingCommands"
            label="Interpret spoken line commands"
            disabled={busy}
          />
        </SettingRow>
      </Group>
    </>
  );
}
