import { Download, LoaderCircle, WandSparkles } from "lucide-react";
import { MAGIC_MODELS, magicModelById } from "../../data";
import { REWRITE_PRESETS } from "../../rewritePresets";
import type { AppSettings, MagicStatus } from "../../types";
import { SettingRow, Toggle } from "../ui";
import { ModelSetupStatus } from "./ModelSetupStatus";
import { ModelProvenance } from "./ModelProvenance";
import { ModelLifecycle } from "./ModelLifecycle";
import { BackendCapabilities } from "./BackendCapabilities";
import { EngineBadge } from "./EngineBadge";
import { RuntimeSetupLog } from "./RuntimeSetupLog";

export type RewriteSetupProps = {
  magicStatus: MagicStatus;
  settings: AppSettings;
  busy: boolean;
  saving: boolean;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onSetupMagic: () => void;
  onCancelSetupMagic?: () => void;
};

/**
 * Rewriting in one card: set the model up, then choose whether every
 * dictation is rewritten and how. The model loads when it is needed.
 */
export function RewriteSetup({
  magicStatus,
  settings: s,
  busy,
  saving,
  onUpdateSettings: save,
  onSetupMagic,
  onCancelSetupMagic,
}: RewriteSetupProps) {
  const model = magicModelById(s.magicModel);
  const engine = magicStatus.engine;
  const installed =
    engine === "ready" || engine === "unloaded" || engine === "loading";
  const installing = ["running", "cancelling"].includes(
    magicStatus.setupState ?? "",
  );
  const working = ["preparing", "loading", "rewriting"].includes(
    magicStatus.phase,
  );
  // Saved as on before the model was set up: keep the switch reachable.
  const showOptions = installed || s.magicEnabled;
  return (
    <section className="setup-card" aria-labelledby="rewrite-model-heading">
      <div className="setup-card-heading">
        <WandSparkles />
        <div>
          <h2 id="rewrite-model-heading">Rewrite</h2>
        </div>
        <EngineBadge engine={engine} />
      </div>
      <p className="setup-status-copy">
        A local model cleans up or restyles what you dictate. It runs on this
        computer.
      </p>
      {showOptions && (
        <div className="pref-list setup-options">
          <SettingRow
            title="Rewrite every dictation"
            description={
              s.magicEnabled
                ? "Rewritten before it is pasted. The original stays in History."
                : "Off: rewrite single transcripts from History."
            }
          >
            <Toggle
              value={s.magicEnabled}
              label="Rewrite every dictation"
              disabled={saving || busy || (!installed && !s.magicEnabled)}
              onChange={() => save({ magicEnabled: !s.magicEnabled })}
            />
          </SettingRow>
          <SettingRow
            title="Style"
            description={
              REWRITE_PRESETS.find((preset) => preset.id === s.magicPreset)
                ?.description
            }
          >
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
            <Toggle
              value={s.magicAllowInferences}
              label="Allow added assumptions"
              disabled={saving || s.magicPreset === "spoken-corrections"}
              onChange={() =>
                save({ magicAllowInferences: !s.magicAllowInferences })
              }
            />
          </SettingRow>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-4">
        <label className="field min-w-[180px] flex-1">
          Model
          <select
            aria-label="Local rewrite model"
            value={s.magicModel}
            disabled={busy || saving || installing}
            onChange={(event) =>
              save({
                magicModel: event.target.value as AppSettings["magicModel"],
              })
            }
          >
            {MAGIC_MODELS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.memory}
              </option>
            ))}
          </select>
        </label>
        <div className="runtime-actions">
          {onCancelSetupMagic && installing && (
            <button
              className="secondary-button"
              disabled={magicStatus.setupState === "cancelling"}
              onClick={onCancelSetupMagic}
            >
              {magicStatus.setupState === "cancelling"
                ? "Cancelling…"
                : "Cancel setup"}
            </button>
          )}
          {/* A failed setup offers Fix setup in the alert below. */}
          {engine === "missing" && (
            <button
              className="primary-button"
              disabled={busy}
              onClick={onSetupMagic}
            >
              {working ? <LoaderCircle className="spin" /> : <Download />}
              Download & set up
            </button>
          )}
        </div>
      </div>
      <p className="setup-status-copy">
        {model.description}
        {engine === "missing" &&
          " After setup, choose whether every dictation is rewritten."}
      </p>
      <ModelSetupStatus
        status={magicStatus}
        kind="rewrite"
        busy={busy}
        onRepair={onSetupMagic}
      />
      {magicStatus.setupState === "cancelled" && (
        <p className="setup-status-copy" role="status">
          {magicStatus.message}
        </p>
      )}
      <details className="setup-details">
        <summary>Details</summary>
        {installed && magicStatus.residency && (
          <ModelLifecycle status={magicStatus} />
        )}
        <BackendCapabilities capabilities={magicStatus.capabilities} />
        <ModelProvenance {...model} />
        <div className="runtime-actions mt-4">
          <RuntimeSetupLog kind="rewrite" />
        </div>
      </details>
    </section>
  );
}
