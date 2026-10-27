import { SettingRow } from "../../components/ui";
import { EncryptedHistory } from "../../components/EncryptedHistory";
import { HistoryRetention } from "../../components/HistoryRetention";
import { LocalData } from "../../components/LocalData";
import type { AppSettings } from "../../types";
import { Group, SettingToggle, type SectionProps } from "./shared";

const HISTORY_LIMITS = [25, 50, 100, 250, 500];

export function PrivacySection({
  onSave,
  ...section
}: SectionProps & {
  onSave: (patch: Partial<AppSettings>) => Promise<boolean>;
}) {
  const { settings: s, saving, save } = section;
  return (
    <>
      <Group title="Logbook">
        <SettingRow
          title="Save transcripts"
          description={
            s.keepHistory
              ? "Kept on this device only."
              : "Off: results last until you quit."
          }
        >
          <SettingToggle
            {...section}
            name="keepHistory"
            label="Save transcripts"
          />
        </SettingRow>
        <SettingRow
          title="Keep the latest"
          description="Older transcripts are deleted automatically."
        >
          <select
            aria-label="History limit"
            value={s.historyLimit}
            disabled={saving || !s.keepHistory}
            onChange={(e) => save({ historyLimit: Number(e.target.value) })}
          >
            {HISTORY_LIMITS.map((count) => (
              <option key={count} value={count}>
                {count} transcripts
              </option>
            ))}
          </select>
        </SettingRow>
      </Group>
      <LocalData />
      <details className="disclosure">
        <summary>Clean up by age or count</summary>
        <HistoryRetention
          policy={s.historyRetention}
          saving={saving}
          onSave={onSave}
        />
      </details>
      <details className="disclosure">
        <summary>Encrypted backup</summary>
        <EncryptedHistory />
      </details>
    </>
  );
}
