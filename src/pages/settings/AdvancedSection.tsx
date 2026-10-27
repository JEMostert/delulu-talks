import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { ConfirmDialog, SettingRow } from "../../components/ui";
import { Diagnostics } from "../../components/Diagnostics";
import { ModelCachePanel } from "../../components/ModelCachePanel";
import { RuntimeSetupSnapshot } from "../../components/RuntimeSetupSnapshot";
import { DecodeControls } from "../../components/models/DecodeControls";
import type { AppSettings, DictationStatus, MagicStatus } from "../../types";
import { Group, SettingToggle, type SectionProps } from "./shared";

const IDLE_MINUTES = [1, 5, 15, 30, 60];

type RuntimeActions = {
  onSetup: () => void;
  onCancelSetup?: () => void;
  onLoad: () => void;
  onUnload: () => void;
};

/** One engine's runtime: its status line, then cancel, load or unload, and set up or repair. */
function RuntimeRow({
  title,
  status,
  busy,
  onSetup,
  onCancelSetup,
  onLoad,
  onUnload,
}: RuntimeActions & {
  title: string;
  status: DictationStatus | MagicStatus;
  busy: boolean;
}) {
  const installing = ["running", "cancelling"].includes(
    status.setupState ?? "",
  );
  return (
    <SettingRow title={title} description={status.message}>
      <div className="inline-control">
        {onCancelSetup && installing && (
          <button
            className="secondary-button compact"
            disabled={status.setupState === "cancelling"}
            onClick={onCancelSetup}
          >
            {status.setupState === "cancelling" ? "Cancelling…" : "Cancel"}
          </button>
        )}
        {status.engine === "ready" ? (
          <button
            className="tool-button compact"
            disabled={busy}
            onClick={onUnload}
          >
            Unload
          </button>
        ) : (
          <button
            className="tool-button compact"
            disabled={busy || status.engine !== "unloaded"}
            onClick={onLoad}
          >
            Load
          </button>
        )}
        <button
          className="secondary-button compact"
          disabled={busy}
          onClick={onSetup}
        >
          {status.engine === "missing" ? "Set up" : "Repair"}
        </button>
      </div>
    </SettingRow>
  );
}

/**
 * Maintenance: models load when needed and sleep when idle, so loading,
 * unloading, repairing and storage live here rather than on each feature.
 */
export function AdvancedSection({
  status,
  magicStatus,
  speech,
  rewriting,
  onReset,
  ...section
}: SectionProps & {
  status: DictationStatus;
  magicStatus: MagicStatus;
  speech: RuntimeActions;
  rewriting: RuntimeActions;
  onReset: () => void;
}) {
  const { settings: s, saving, busy, save } = section;
  const [python, setPython] = useState(s.pythonCommand);
  const [remove, setRemove] = useState(false);
  // The snapshot probes interpreters, so it only runs once someone looks.
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  useEffect(() => setPython(s.pythonCommand), [s.pythonCommand]);

  return (
    <>
      <Group title="Models">
        <RuntimeRow title="Speech" status={status} busy={busy} {...speech} />
        <RuntimeRow
          title="Rewriting"
          status={magicStatus}
          busy={busy}
          {...rewriting}
        />
        <SettingRow
          title="Keep speech ready"
          description="Loads at start. Uses memory while idle."
        >
          <SettingToggle
            {...section}
            name="preloadModel"
            label="Keep the speech model ready"
            disabled={busy}
          />
        </SettingRow>
        <SettingRow
          title="Keep rewriting ready"
          description="Uses memory while idle."
        >
          <SettingToggle
            {...section}
            name="preloadMagicModel"
            label="Keep rewriting ready"
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

      <Group title="Runtimes">
        <SettingRow title="Python" description="New installs use 3.11–3.13.">
          <div className="inline-control">
            <input
              className="w-40"
              aria-label="Python command"
              value={python}
              onChange={(e) => setPython(e.target.value)}
            />
            <button
              className="secondary-button compact"
              disabled={
                saving || busy || python === s.pythonCommand || !python.trim()
              }
              onClick={() => save({ pythonCommand: python })}
            >
              Save
            </button>
          </div>
        </SettingRow>
        <SettingRow
          title="Remove runtimes"
          description="Settings, history and downloaded models stay."
        >
          <button
            className="danger-button compact"
            disabled={busy}
            onClick={() => setRemove(true)}
          >
            <Trash2 />
            Remove
          </button>
        </SettingRow>
      </Group>

      <Diagnostics />
      <ModelCachePanel
        status={status}
        magicStatus={magicStatus}
        busy={busy || saving}
      />
      <DecodeControls settings={s} />
      <details
        className="disclosure"
        onToggle={(event) => setRuntimeOpen(event.currentTarget.open)}
      >
        <summary>Runtime details</summary>
        {runtimeOpen && (
          <RuntimeSetupSnapshot
            pythonCommand={s.pythonCommand}
            magicModel={s.magicModel}
            busy={busy}
          />
        )}
      </details>

      {remove && (
        <ConfirmDialog
          title="Remove the local runtimes?"
          confirmLabel="Remove"
          onClose={() => setRemove(false)}
          onConfirm={onReset}
        >
          <p>
            You’ll need to set up speech again before dictating. Your history,
            settings and downloaded models stay on this device.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
