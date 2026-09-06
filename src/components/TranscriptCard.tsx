import { RewriteDialog } from "./RewriteDialog";
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
  MagicRewriteRequest,
  MagicRewriteResult,
  MagicStatus,
  CustomWord,
  ExportFormat,
  TranscriptRecord,
  TranscriptVersion,
} from "../types";

export type TranscriptActions = {
  onRewrite?: (request: MagicRewriteRequest) => Promise<MagicRewriteResult>;
  onSetRewrite?: (
    id: string,
    result: MagicRewriteResult | null,
    sourceText: string,
  ) => Promise<boolean>;
  onRewriteSetup?: () => void;
  rewriteStatus?: MagicStatus;
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
  inspector = false,
  onCopy,
  onUpdateTranscript,
  onDelete,
  onExport,
  onRemember,
  onRewrite,
  onSetRewrite,
  onRewriteSetup,
  rewriteStatus,
}: TranscriptActions & {
  record: TranscriptRecord;
  defaultOpen?: boolean;
  inspector?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen || inspector);
  const [version, setVersion] = useState<TranscriptVersion | "delivered">(
    record.magicText ||
      (record.deliveredVersion !== "verbatim" &&
        record.personalizedText &&
        record.personalizedText !== record.intendedText)
      ? "delivered"
      : record.intendedText
        ? "intended"
        : "verbatim",
  );
  const [rewriting, setRewriting] = useState(false);
  const [correctionSuggested, setCorrectionSuggested] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [rememberError, setRememberError] = useState<string | null>(null);
  const [remember, setRemember] = useState(false);
  const [heard, setHeard] = useState("");
  const [correct, setCorrect] = useState("");
  const sourceVersion =
    version === "delivered" ? (record.deliveredVersion ?? "intended") : version;
  const text =
    version === "delivered"
      ? deliveredText(record)
      : transcriptText(record, version);
  const edited = version !== "delivered" && transcriptIsEdited(record, version);
  const date = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(record.createdAt);
  const save = async () => {
    setSaving(true);
    try {
      if (await onUpdateTranscript(record.id, sourceVersion, draft)) {
        setEditing(false);
        const before = text.trim().split(/\s+/),
          after = draft.trim().split(/\s+/);
        let start = 0,
          tail = 0;
        while (
          start < Math.min(before.length, after.length) &&
          before[start] === after[start]
        )
          start++;
        while (
          tail < Math.min(before.length, after.length) - start &&
          before[before.length - 1 - tail] === after[after.length - 1 - tail]
        )
          tail++;
        const from = before
          .slice(start, before.length - tail)
          .join(" ")
          .replace(/[.,!?;:]+$/, "");
        const to = after
          .slice(start, after.length - tail)
          .join(" ")
          .replace(/[.,!?;:]+$/, "");
        if (
          from &&
          to &&
          from !== to &&
          from.length <= 256 &&
          to.length <= 256
        ) {
          setHeard(from);
          setCorrect(to);
          setCorrectionSuggested(true);
        }
      }
    } finally {
      setSaving(false);
    }
  };
  return (
    <article
      className={`transcript-card ${open ? "expanded" : ""} ${inspector ? "inspector-card" : ""}`}
    >
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
                · <WandSparkles /> Rewritten
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
      {!inspector && (
        <p className={`transcript-preview ${open ? "full" : ""}`}>
          {deliveredText(record)}
        </p>
      )}
      {!inspector && (
        <footer>
          <span className="caption">
            {deliveredText(record).trim().split(/\s+/).filter(Boolean).length}{" "}
            words
            {record.magicIncludedInferences
              ? " · Review added assumptions"
              : ""}
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
      )}
      {open && (
        <div className="transcript-detail">
          <div className="panel-toolbar">
            <div
              className="segmented"
              role="group"
              aria-label="Transcript version"
            >
              {(
                [
                  ...(record.magicText ||
                  (record.deliveredVersion !== "verbatim" &&
                    record.personalizedText &&
                    record.personalizedText !== record.intendedText)
                    ? ["delivered" as const]
                    : []),
                  "intended",
                  "verbatim",
                ] as const
              )
                .filter((v) =>
                  v === "delivered"
                    ? true
                    : v === "intended"
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
                    {v === "delivered"
                      ? "Result"
                      : v === "intended"
                        ? "Clean"
                        : "Verbatim"}
                  </button>
                ))}
            </div>
            <span className="caption">
              {version === "delivered"
                ? record.magicText
                  ? "Optional rewrite"
                  : "Corrections & shortcuts applied"
                : edited
                  ? "Your correction"
                  : "Original speech"}
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
                {version !== "delivered" && (
                  <button
                    className="tool-button"
                    onClick={() => {
                      setDraft(text);
                      setEditing(true);
                    }}
                  >
                    <Pencil /> Edit
                  </button>
                )}
                <button className="tool-button" onClick={() => onCopy(text)}>
                  <Copy /> Copy{" "}
                  {version === "delivered"
                    ? "result"
                    : version === "intended"
                      ? "clean"
                      : "verbatim"}
                </button>
                {edited && (
                  <button
                    className="tool-button"
                    onClick={() =>
                      void onUpdateTranscript(record.id, sourceVersion, null)
                    }
                  >
                    <RotateCcw /> Restore
                  </button>
                )}
                {onRewrite && onSetRewrite && (
                  <button
                    className="tool-button"
                    disabled={saving}
                    onClick={() => setRewriting(true)}
                  >
                    <WandSparkles /> Rewrite
                  </button>
                )}
                {record.magicText && onSetRewrite && (
                  <button
                    className="tool-button"
                    disabled={saving}
                    onClick={async () => {
                      setSaving(true);
                      try {
                        if (
                          await onSetRewrite(
                            record.id,
                            null,
                            deliveredText(record),
                          )
                        )
                          setVersion(
                            record.personalizedText !== record.intendedText &&
                              record.personalizedText
                              ? "delivered"
                              : record.intendedText
                                ? "intended"
                                : "verbatim",
                          );
                      } finally {
                        setSaving(false);
                      }
                    }}
                  >
                    <RotateCcw /> Undo rewrite
                  </button>
                )}
                {onRemember && (
                  <button
                    className="tool-button"
                    onClick={() => {
                      if (!correctionSuggested) {
                        setHeard(
                          window
                            .getSelection()
                            ?.toString()
                            .trim()
                            .slice(0, 256) ?? "",
                        );
                        setCorrect("");
                      }
                      setRemember(true);
                    }}
                  >
                    <BookPlus /> Remember correction
                  </button>
                )}
              </>
            )}
          </div>
          {correctionSuggested && !remember && (
            <div className="correction-suggestion">
              <span>
                Remember “{heard}” → “{correct}” for next time?
              </span>
              <button className="text-button" onClick={() => setRemember(true)}>
                Review rule
              </button>
              <button
                className="text-button"
                onClick={() => setCorrectionSuggested(false)}
              >
                Dismiss
              </button>
            </div>
          )}
          {onExport && (
            <div className="export-row">
              <span title="Subtitles use the original model words and timing, before corrections or rewriting.">
                Export · original timing for subtitles
              </span>
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
      {rewriting && onRewrite && onSetRewrite && (
        <RewriteDialog
          text={text}
          baseline={deliveredText(record)}
          status={rewriteStatus}
          onClose={() => setRewriting(false)}
          onSetup={onRewriteSetup ?? (() => {})}
          onRewrite={onRewrite}
          onApply={async (result, source) => {
            const applied = await onSetRewrite(record.id, result, source);
            if (applied) setVersion("delivered");
            return applied;
          }}
        />
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
          title="Remember correction"
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
                  heard.trim() === correct.trim()
                }
                onClick={async () => {
                  setSaving(true);
                  setRememberError(null);
                  try {
                    if (
                      await onRemember?.({
                        kind: "correction",
                        id: crypto.randomUUID(),
                        term: correct.trim(),
                        soundsLike: heard.trim(),
                        replacement: "",
                        enabled: true,
                      })
                    ) {
                      setRemember(false);
                      setCorrectionSuggested(false);
                      setHeard("");
                      setCorrect("");
                    } else {
                      setRememberError(
                        "The correction could not be saved. Please try again.",
                      );
                    }
                  } catch (reason) {
                    setRememberError(
                      reason instanceof Error ? reason.message : String(reason),
                    );
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                Save correction rule
              </button>
            </>
          }
        >
          {rememberError && (
            <p className="field-error" role="alert">
              {rememberError}
            </p>
          )}
          <p>
            Replace this recognized phrase in future clean results. This does
            not train the speech model.
          </p>
          <label className="field">
            Recognized text
            <input
              autoFocus
              maxLength={256}
              value={heard}
              onChange={(e) => setHeard(e.target.value)}
              placeholder="e.g. the lulu"
            />
          </label>
          <label className="field">
            Replace with
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
