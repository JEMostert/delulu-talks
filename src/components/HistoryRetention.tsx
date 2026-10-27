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
  age: "Too old",
  count: "Beyond the count",
  ageAndCount: "Too old and beyond the count",
};

function RecordText({ record }: { record: TranscriptRecord }) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-sm">Show stored text</summary>
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
          `${label} must be a whole number from ${minimum} to ${maximum}, or empty for no limit.`,
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
        throw new Error("Could not save. Your previous limits still apply.");
      setMessage("Limits saved. Nothing was removed.");
    });
  const apply = () => {
    if (!preview) return;
    const token = preview.token;
    void run(async () => {
      try {
        const removed = await bridge.applyHistoryRetention(token);
        setPreview(null);
        setMessage(
          `Removed ${removed.length} ${removed.length === 1 ? "transcript" : "transcripts"}.`,
        );
      } catch (cause) {
        setPreview(null);
        throw cause;
      }
    });
  };

  return (
    <section className="settings-group">
      <SettingRow title="Older than (days)">
        <input
          className="w-28"
          aria-label="History maximum age in days"
          type="number"
          min={1}
          max={36_500}
          step={1}
          placeholder="No limit"
          value={days}
          disabled={pending || saving}
          onChange={(event) => change(setDays, event.target.value)}
        />
      </SettingRow>
      <SettingRow title="Keep the newest" description="0 keeps none.">
        <input
          className="w-28"
          aria-label="History maximum record count"
          type="number"
          min={0}
          max={500}
          step={1}
          placeholder="No limit"
          value={count}
          disabled={pending || saving}
          onChange={(event) => change(setCount, event.target.value)}
        />
      </SettingRow>
      <div className="px-6 py-4">
        <p className="text-sm text-muted">
          Nothing is removed until you review and apply.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className="secondary-button"
            disabled={pending || saving}
            onClick={savePolicy}
          >
            Save limits
          </button>
          <button
            className="secondary-button"
            disabled={pending || saving}
            onClick={previewRecords}
          >
            Review
          </button>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error} Review again before applying.
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
          title="Remove old transcripts?"
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
                {pending ? "Applying…" : `Remove ${preview.affected.length}`}
              </button>
            </>
          }
        >
          <p>
            {preview.affected.length} of {preview.totalSaved} transcripts will
            be removed; {preview.retainedCount} stay.
          </p>
          <p className="mt-2 text-sm text-muted">
            Limits:{" "}
            {preview.policy.maxAgeDays === null
              ? "any age"
              : `${preview.policy.maxAgeDays} days`}
            ,{" "}
            {preview.policy.maxCount === null
              ? "any count"
              : `newest ${preview.policy.maxCount}`}
            . Checked {new Date(preview.previewedAt).toLocaleString()}.
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
            Removal is permanent. Exports, backups and imported audio files are
            separate copies and stay.
          </p>
          {preview.affected.length === 0 ? (
            <p className="mt-4">Nothing matches these limits.</p>
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
