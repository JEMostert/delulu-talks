import { useEffect, useState } from "react";
import { Download, RefreshCw, Trash2 } from "lucide-react";
import { ConfirmDialog, SettingRow } from "../../components/ui";
import type { DictationStatus, MagicStatus, UpdateStatus } from "../../types";
import { Group, type SectionProps } from "./shared";

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

export function AdvancedSection({
  status,
  magicStatus,
  update,
  speech,
  rewriting,
  onReset,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate,
  ...section
}: SectionProps & {
  status: DictationStatus;
  magicStatus: MagicStatus;
  update: UpdateStatus;
  speech: RuntimeActions;
  rewriting: RuntimeActions;
  onReset: () => void;
  onCheckForUpdates: () => void;
  onDownloadUpdate: () => void;
  onInstallUpdate: () => void;
}) {
  const { settings: s, saving, busy, save } = section;
  const [python, setPython] = useState(s.pythonCommand);
  const [remove, setRemove] = useState(false);
  useEffect(() => setPython(s.pythonCommand), [s.pythonCommand]);

  return (
    <>
      <Group title="Runtimes">
        <RuntimeRow title="Speech" status={status} busy={busy} {...speech} />
        <RuntimeRow
          title="Rewriting"
          status={magicStatus}
          busy={busy}
          {...rewriting}
        />
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
          description="Settings, Logbook and downloaded engines stay."
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

      <Group title="Updates">
        <SettingRow
          icon={RefreshCw}
          title={`Delulu Talks ${update.currentVersion || "development"}`}
          description={update.message}
        >
          <div className="inline-control">
            {update.phase === "available" ? (
              <button
                className="primary-button compact"
                onClick={onDownloadUpdate}
              >
                <Download />
                Download {update.version}
              </button>
            ) : update.phase === "downloaded" ? (
              <button
                className="primary-button compact"
                disabled={busy}
                onClick={onInstallUpdate}
              >
                Restart & update
              </button>
            ) : (
              <button
                className="secondary-button compact"
                disabled={
                  update.phase === "unsupported" ||
                  update.phase === "checking" ||
                  update.phase === "downloading"
                }
                onClick={onCheckForUpdates}
              >
                {update.phase === "checking" ? "Checking…" : "Check now"}
              </button>
            )}
          </div>
        </SettingRow>
        {update.phase === "downloading" && (
          <div className="setting-row">
            <progress
              aria-label="Update download"
              max={100}
              value={update.percent ?? 0}
            />
            <span className="caption tabular-nums">
              {Math.round(update.percent ?? 0)}%
            </span>
          </div>
        )}
        <div className="setting-row">
          <a
            className="text-button"
            href="https://github.com/JEMostert/delulu-talks/releases"
            target="_blank"
            rel="noreferrer"
          >
            Release notes ↗
          </a>
        </div>
      </Group>

      {remove && (
        <ConfirmDialog
          title="Remove the local runtimes?"
          confirmLabel="Remove"
          onClose={() => setRemove(false)}
          onConfirm={onReset}
        >
          <p>
            You’ll need to set up speech again before dictating. Your Logbook,
            settings and downloaded engines stay on this device.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
