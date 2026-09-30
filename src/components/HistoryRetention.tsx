import { useState } from "react";
import { bridge } from "../bridge";
import type {
  AppSettings,
  HistoryRetentionPolicy,
  HistoryRetentionPreview,
  TranscriptRecord,
} from "../types";
import { Modal, SettingRow } from "./ui";

const reasonLabels = {
  age: "Older than the age limit",
  count: "Outside the newest-record count",
  ageAndCount: "Outside both age and count limits",
};

function RecordText({ record }: { record: TranscriptRecord }) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-sm">
        Review stored text and provenance
      </summary>
      {[
        ["Original", record.text],
        ["Personalized", record.personalizedText],
        ["Correction", record.editedText],
        ["Rewrite", record.magicText],
      ].map(
        ([label, text]) =>
          text != null && (
            <div key={label} className="mt-2">
              <strong className="text-xs">{label}</strong>
              <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-sm">
                {text}
              </pre>
            </div>
          ),
      )}
      <p className="mt-2 break-words text-xs text-muted">
        Record {record.id} ·{" "}
        {record.source === "file"
          ? `Imported file: ${record.sourceName ?? "audio"}`
          : "Dictation"}{" "}
        · {record.model} · {record.language}
        {record.magicModel &&
          ` · Rewrite: ${record.magicModel}${record.magicPreset ? ` / ${record.magicPreset}` : ""}`}
      </p>
    </details>
  );
}

export function HistoryRetention({
  policy: saved,
  saving,
  onSave,
}: {
  policy: HistoryRetentionPolicy | undefined;
  saving: boolean;
  onSave: (patch: Partial<AppSettings>) => Promise<boolean>;
}) {
  const [days, setDays] = useState(saved?.maxAgeDays?.toString() ?? "");
  const [count, setCount] = useState(saved?.maxCount?.toString() ?? "");
  const [preview, setPreview] = useState<HistoryRetentionPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const policy = (): HistoryRetentionPolicy => {
    const number = (
      value: string,
      minimum: number,
      maximum: number,
      label: string,
    ) => {
      if (!value.trim()) return null;
      const next = Number(value);
      if (!Number.isInteger(next) || next < minimum || next > maximum)
        throw new Error(
          `${label} must be a whole number from ${minimum} to ${maximum}, or leave it empty for unlimited.`,
        );
      return next;
    };
    return {
      maxAgeDays: number(days, 1, 36_500, "Age"),
      maxCount: number(count, 0, 500, "Count"),
    };
  };
  const change = (receive: (value: string) => void, value: string) => {
    receive(value);
    setPreview(null);
    setError(null);
    setMessage(null);
  };
  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  const previewRecords = () =>
    void run(async () => {
      setPreview(await bridge.previewHistoryRetention(policy()));
    });
  const savePolicy = () =>
    void run(async () => {
      if (!(await onSave({ historyRetention: policy() })))
        throw new Error(
          "Could not save the retention policy. Your previous policy remains saved.",
        );
      setMessage(
        "Policy saved. No records were removed. Preview and apply when you choose.",
      );
    });
  const apply = () => {
    if (!preview) return;
    const token = preview.token;
    void run(async () => {
      try {
        const removed = await bridge.applyHistoryRetention(token);
        setPreview(null);
        setMessage(
          `Removed ${removed.length} saved ${removed.length === 1 ? "record" : "records"}.`,
        );
      } catch (cause) {
        setPreview(null);
        throw cause;
      }
    });
  };

  return (
    <section className="settings-group">
      <div className="group-heading">
        <h3>History retention</h3>
        <p>
          Choose limits for saved history. Cleanup is manual: preview first,
          then explicitly apply.
        </p>
      </div>
      <SettingRow
        title="Maximum age"
        description="Records strictly older than this many 24-hour days are selected. Empty means unlimited."
      >
        <input
          aria-label="History maximum age in days"
          type="number"
          min={1}
          max={36_500}
          step={1}
          placeholder="Unlimited"
          value={days}
          disabled={pending || saving}
          onChange={(event) => change(setDays, event.target.value)}
        />
      </SettingRow>
      <SettingRow
        title="Maximum count"
        description="Keep the newest saved records by recording date. Empty means unlimited; 0 selects every saved record."
      >
        <input
          aria-label="History maximum record count"
          type="number"
          min={0}
          max={500}
          step={1}
          placeholder="Unlimited"
          value={count}
          disabled={pending || saving}
          onChange={(event) => change(setCount, event.target.value)}
        />
      </SettingRow>
      <div className="px-6 py-4">
        <p className="text-sm text-muted">
          Either limit can select a record. Saving a policy never starts
          automatic deletion. Session-only results that were not saved are
          excluded.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className="secondary-button"
            disabled={pending || saving}
            onClick={savePolicy}
          >
            Save policy
          </button>
          <button
            className="secondary-button"
            disabled={pending || saving}
            onClick={previewRecords}
          >
            Preview affected records
          </button>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error} Preview again before applying.
          </p>
        )}
        {message && (
          <p role="status" className="mt-3 text-sm">
            {message}
          </p>
        )}
      </div>
      {preview && (
        <Modal
          title="Review history retention"
          busy={pending}
          onClose={() => setPreview(null)}
          footer={
            <>
              <button
                className="secondary-button"
                disabled={pending}
                onClick={() => setPreview(null)}
              >
                Cancel
              </button>
              <button
                className="danger-button"
                disabled={pending || preview.affected.length === 0}
                onClick={apply}
              >
                {pending
                  ? "Applying…"
                  : `Remove ${preview.affected.length} saved ${preview.affected.length === 1 ? "record" : "records"}`}
              </button>
            </>
          }
        >
          <p>
            {preview.affected.length} of {preview.totalSaved} saved records will
            be removed; {preview.retainedCount} will remain.
          </p>
          <p className="mt-2 text-sm text-muted">
            Limits:{" "}
            {preview.policy.maxAgeDays === null
              ? "unlimited age"
              : `${preview.policy.maxAgeDays} days`}{" "}
            and{" "}
            {preview.policy.maxCount === null
              ? "unlimited count"
              : `newest ${preview.policy.maxCount} records`}
            . Preview calculated{" "}
            {new Date(preview.previewedAt).toLocaleString()}.
          </p>
          <dl
            className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm"
            aria-label="Retention effects"
          >
            <dt>Original transcripts removed</dt>
            <dd>{preview.effects.originals}</dd>
            <dt>Personalized variants removed</dt>
            <dd>{preview.effects.personalized}</dd>
            <dt>Corrections removed</dt>
            <dd>{preview.effects.corrections}</dd>
            <dt>Rewrites removed</dt>
            <dd>{preview.effects.rewrites}</dd>
            <dt>Imported-file references removed</dt>
            <dd>{preview.effects.importedReferences}</dd>
            <dt>Source audio files deleted</dt>
            <dd>{preview.effects.audioFilesDeleted}</dd>
          </dl>
          <p className="mt-3 text-sm">
            Removal is permanent and deletes each selected record’s original
            transcript, personalized text, correction, rewrite and history
            metadata together. Export anything you want to keep before applying.
            Imported source audio files, model cache, runtimes and other
            settings are preserved. Any source-file reference stored with a
            removed record is removed from history; the external audio stays
            where you saved it.
          </p>
          <p className="mt-2 text-sm text-muted">
            Previously exported files and existing backups are separate copies
            and are not erased by retention. This is not a secure-erasure
            operation.
          </p>
          <p className="mt-2 text-sm text-muted">
            If history changes, apply will stop and ask you to preview again.
            Retained records keep all their text and provenance.
          </p>
          {preview.affected.length === 0 ? (
            <p className="mt-4">
              No saved records match these limits. Nothing will be removed.
            </p>
          ) : (
            <ul className="mt-4 list-none space-y-3 p-0">
              {preview.affected.map(({ record, reason }) => (
                <li
                  key={record.id}
                  className="rounded-lg border border-line p-3"
                >
                  <p className="text-sm font-medium">
                    {new Date(record.createdAt).toLocaleString()} ·{" "}
                    {reasonLabels[reason]}
                  </p>
                  <p className="mt-1 break-words text-sm text-muted">
                    {record.text.slice(0, 180)}
                    {record.text.length > 180 && "…"}
                  </p>
                  <RecordText record={record} />
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}
    </section>
  );
}
