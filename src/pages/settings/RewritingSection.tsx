import { MAGIC_MODELS } from "../../data";
import { REWRITE_PRESETS } from "../../rewritePresets";
import { SettingRow } from "../../components/ui";
import type { AppSettings, MagicStatus } from "../../types";
import { Group, SettingToggle, type SectionProps } from "./shared";

export function RewritingSection({
  magicStatus,
  onSetupMagic,
  ...section
}: SectionProps & { magicStatus: MagicStatus; onSetupMagic: () => void }) {
  const { settings: s, saving, busy, save } = section;
  const missing = magicStatus.engine === "missing";
  return (
    <>
      <Group title="After dictation">
        <SettingRow
          title="Rewrite dictation"
          description="The original stays in your Logbook."
        >
          <SettingToggle
            {...section}
            name="magicEnabled"
            label="Rewrite dictation"
            disabled={busy}
          />
        </SettingRow>
        <SettingRow title="Style">
          <select
            aria-label="Rewrite style"
            value={s.magicPreset}
            disabled={saving}
            onChange={(e) =>
              save({
                ...(e.target.value === "spoken-corrections"
                  ? { magicAllowInferences: false }
                  : {}),
                magicPreset: e.target.value as AppSettings["magicPreset"],
              })
            }
          >
            {REWRITE_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow
          title="Allow assumptions"
          description="Lets rewriting fill in missing detail."
        >
          <SettingToggle
            {...section}
            name="magicAllowInferences"
            label="Allow added assumptions"
            disabled={s.magicPreset === "spoken-corrections"}
          />
        </SettingRow>
      </Group>

      <Group title="Engine">
        <SettingRow
          title="Model"
          description={missing ? "Not set up yet." : undefined}
        >
          <div className="inline-control">
            <select
              aria-label="Rewrite model"
              value={s.magicModel}
              disabled={saving || busy}
              onChange={(e) =>
                save({
                  magicModel: e.target.value as AppSettings["magicModel"],
                })
              }
            >
              {MAGIC_MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name} · {model.memory}
                </option>
              ))}
            </select>
            {missing && (
              <button
                className="secondary-button compact"
                disabled={busy}
                onClick={onSetupMagic}
              >
                Set up
              </button>
            )}
          </div>
        </SettingRow>
        <SettingRow title="Keep ready" description="Uses memory while idle.">
          <SettingToggle
            {...section}
            name="preloadMagicModel"
            label="Keep rewriting ready"
            disabled={busy}
          />
        </SettingRow>
        <SettingRow
          title="Memory"
          description="Balanced runs speech and rewriting one at a time."
        >
          <select
            aria-label="Memory policy"
            value={s.memoryPolicy}
            disabled={saving || busy}
            onChange={(e) =>
              save({
                memoryPolicy: e.target.value as AppSettings["memoryPolicy"],
              })
            }
          >
            <option value="independent">Independent</option>
            <option value="balanced">Balanced</option>
          </select>
        </SettingRow>
      </Group>
    </>
  );
}
