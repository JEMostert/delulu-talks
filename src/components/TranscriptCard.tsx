import { useState } from "react";
import {
  BookPlus,
  Check,
  ChevronDown,
  Copy,
  Download,
  FileAudio,
  Mic,
  Pencil,
  RotateCcw,
  Trash2,
  WandSparkles,
} from "lucide-react";
import {
  deliveredText,
  transcriptIsEdited,
  transcriptText,
} from "../transcriptText";
import { ConfirmDialog, Modal } from "./ui";
import type {
  CustomWord,
  ExportFormat,
  TranscriptRecord,
  TranscriptVersion,
} from "../types";

export type TranscriptActions = {
  onCopy: (text: string) => void;
  onUpdateTranscript: (
    id: string,
    version: TranscriptVersion,
    text: string | null,
  ) => Promise<boolean>;
  onDelete?: (id: string) => void;
  onExport?: (id: string, format: ExportFormat) => void;
  onRemember?: (word: CustomWord) => Promise<boolean>;
};
export function TranscriptCard({
  record,
  defaultOpen = false,
  onCopy,
  onUpdateTranscript,
  onDelete,
  onExport,
  onRemember,
}: TranscriptActions & { record: TranscriptRecord; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [version, setVersion] = useState<TranscriptVersion>(
    record.intendedText ? "intended" : "verbatim",
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [remember, setRemember] = useState(false);
  const [heard, setHeard] = useState("");
  const [correct, setCorrect] = useState("");
  const text = transcriptText(record, version);
  const edited = transcriptIsEdited(record, version);
  const date = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(record.createdAt);
  const save = async () => {
    setSaving(true);
    try {
      if (await onUpdateTranscript(record.id, version, draft))
        setEditing(false);
    } finally {
      setSaving(false);
    }
  };
  return (
    <article className={`transcript-card ${open ? "expanded" : ""}`}>
      <header>
        <span className="transcript-icon">
          {record.source === "dictation" ? <Mic /> : <FileAudio />}
        </span>
        <div className="transcript-meta">
          <strong>{record.sourceName ?? "Dictation"}</strong>
          <span>
            {date} · {Math.max(1, Math.round(record.durationMs / 1000))}s{" "}
            {record.magicText && (
              <>
                · <WandSparkles /> Magic
              </>
            )}
          </span>
        </div>
        <div className="panel-actions">
          <button
            className="icon-button"
            aria-label="Copy delivered text"
            title="Copy delivered text"
            onClick={() => onCopy(deliveredText(record))}
          >
            <Copy />
          </button>
          {onDelete && (
            <button
              className="icon-button"
              aria-label="Delete transcript"
              title="Delete transcript"
              onClick={() => setDeleting(true)}
            >
              <Trash2 />
            </button>
          )}
        </div>
      </header>
      <p className={`transcript-preview ${open ? "full" : ""}`}>
        {deliveredText(record)}
      </p>
      <footer>
        <span className="caption">
          {deliveredText(record).trim().split(/\s+/).filter(Boolean).length}{" "}
          words
          {record.magicIncludedInferences ? " · Review added assumptions" : ""}
          {edited ? " · Corrected" : ""}
        </span>
        <button
          className="text-button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Close details" : "Review transcript"}
          <ChevronDown className={open ? "rotated" : ""} />
        </button>
      </footer>
      {open && (
        <div className="transcript-detail">
          <div className="panel-toolbar">
            <div
              className="segmented"
              role="group"
              aria-label="Transcript version"
            >
              {(["intended", "verbatim"] as const)
                .filter((v) =>
                  v === "intended"
                    ? record.intendedText || !record.verbatimText
                    : record.verbatimText,
                )
                .map((v) => (
                  <button
                    key={v}
                    className={version === v ? "active" : ""}
                    aria-pressed={version === v}
                    disabled={editing}
                    onClick={() => setVersion(v)}
                  >
                    {v === "intended" ? "Clean" : "Verbatim"}
                  </button>
                ))}
            </div>
            <span className="caption">
              {edited ? "Your correction" : "Original speech"}
            </span>
          </div>
          {editing ? (
            <textarea
              aria-label="Correct transcript"
              className="transcript-editor"
              maxLength={500_000}
              value={draft}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setEditing(false);
                if (
                  event.key === "Enter" &&
                  (event.metaKey || event.ctrlKey) &&
                  draft.trim()
                )
                  void save();
              }}
            />
          ) : (
            <div className="transcript-original">{text}</div>
          )}
          <div className="detail-actions">
            {editing ? (
              <>
                <button
                  className="secondary-button"
                  disabled={saving}
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </button>
                <button
                  className="primary-button"
                  disabled={saving || !draft.trim() || draft.trim() === text}
                  onClick={() => void save()}
                >
                  <Check />
                  {saving ? "Saving…" : "Save correction"}
                </button>
              </>
            ) : (
              <>
                <button
                  className="tool-button"
                  onClick={() => {
                    setDraft(text);
                    setEditing(true);
                  }}
                >
                  <Pencil /> Edit
                </button>
                <button className="tool-button" onClick={() => onCopy(text)}>
                  <Copy /> Copy {version === "intended" ? "clean" : "verbatim"}
                </button>
                {edited && (
                  <button
                    className="tool-button"
                    onClick={() =>
                      void onUpdateTranscript(record.id, version, null)
                    }
                  >
                    <RotateCcw /> Restore
                  </button>
                )}
                {onRemember && (
                  <button
                    className="tool-button"
                    onClick={() => setRemember(true)}
                  >
                    <BookPlus /> Remember a word
                  </button>
                )}
              </>
            )}
          </div>
          {onExport && (
            <div className="export-row">
              <span>Export</span>
              {(
                [
                  "txt",
                  "json",
                  ...(record.words.length || record.verbatimWords.length
                    ? ["srt", "vtt"]
                    : []),
                ] as ExportFormat[]
              ).map((format) => (
                <button
                  className="tool-button"
                  key={format}
                  onClick={() => onExport(record.id, format)}
                >
                  <Download />
                  {format.toUpperCase()}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete this transcript?"
          confirmLabel="Delete transcript"
          onClose={() => setDeleting(false)}
          onConfirm={() => onDelete?.(record.id)}
        >
          <p>
            This removes the transcript and its corrections from local history.
          </p>
        </ConfirmDialog>
      )}
      {remember && (
        <Modal
          title="Remember a word"
          busy={saving}
          onClose={() => setRemember(false)}
          footer={
            <>
              <button
                className="secondary-button"
                onClick={() => setRemember(false)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={
                  saving ||
                  !heard.trim() ||
                  !correct.trim() ||
                  heard.trim().toLowerCase() === correct.trim().toLowerCase()
                }
                onClick={async () => {
                  setSaving(true);
                  try {
                    if (
                      await onRemember?.({
                        id: crypto.randomUUID(),
                        term: correct.trim(),
                        soundsLike: heard.trim(),
                        replacement: "",
                        enabled: true,
                      })
                    ) {
                      setRemember(false);
                      setHeard("");
                      setCorrect("");
                    }
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                Save to Wordbook
              </button>
            </>
          }
        >
          <p>Teach Delulu a name or phrase to correct in future transcripts.</p>
          <label className="field">
            What it heard
            <input
              autoFocus
              maxLength={256}
              value={heard}
              onChange={(e) => setHeard(e.target.value)}
              placeholder="e.g. the lulu"
            />
          </label>
          <label className="field">
            What you meant
            <input
              maxLength={256}
              value={correct}
              onChange={(e) => setCorrect(e.target.value)}
              placeholder="e.g. Delulu"
            />
          </label>
        </Modal>
      )}
    </article>
  );
}
