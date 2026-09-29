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
  onUpdateTranscript: (id: string, text: string | null) => Promise<boolean>;
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
  const [showSource, setShowSource] = useState(false);
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
  const delivered = deliveredText(record);
  const edited = transcriptIsEdited(record);
  const text = showSource ? transcriptText(record) : delivered;
  const date = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(record.createdAt);
  const save = async () => {
    setSaving(true);
    try {
      if (await onUpdateTranscript(record.id, draft)) {
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
      className={`transcript-card ${open ? "expanded" : ""} ${
        inspector
          ? "inspector-card rounded-none border-0 p-[14px] shadow-none"
          : "rounded-panel border border-line bg-surface shadow-panel backdrop-blur-xl p-[15px_18px]"
      }`}
    >
      <header className="flex items-center gap-2.5">
        <span className="transcript-icon grid size-8 place-items-center rounded-md bg-soft text-muted [&_svg]:size-[15px]">
          {record.source === "dictation" ? <Mic /> : <FileAudio />}
        </span>
        <div className="transcript-meta flex-1">
          <strong className="block text-[12px]">
            {record.sourceName ?? "Dictation"}
          </strong>
          <span className="mt-[3px] flex items-center gap-1 text-[10px] text-muted">
            {date} · {Math.max(1, Math.round(record.durationMs / 1000))}s{" "}
            {record.magicText && (
              <>
                · <WandSparkles className="size-[11px]" /> Rewritten
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
        <p
          className={`transcript-preview mt-4 text-[15px] leading-[1.85] text-ink whitespace-pre-wrap wrap-anywhere ${
            open ? "block line-clamp-none" : "line-clamp-3"
          }`}
        >
          {deliveredText(record)}
        </p>
      )}
      {!inspector && (
        <footer className="mt-4 flex items-center justify-between gap-3">
          <span className="caption text-[10px]">
            {deliveredText(record).trim().split(/\s+/).filter(Boolean).length}{" "}
            words
            {record.magicIncludedInferences
              ? " · Review added assumptions"
              : ""}
            {edited ? " · Corrected" : ""}
          </span>
          <button
            className="text-button min-h-[26px] py-0 text-[11px]"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? "Close details" : "Review transcript"}
            <ChevronDown className={`size-[13px] ${open ? "rotated" : ""}`} />
          </button>
        </footer>
      )}
      {open && (
        <div
          className={`transcript-detail ${
            inspector ? "mt-1 border-0" : "mt-4 border-t border-line"
          }`}
        >
          <div
            className={`panel-toolbar ${
              inspector
                ? "flex-wrap pt-2.5"
                : "border-b-0 px-0 pb-2.5 pt-[18px]"
            }`}
          >
            <div
              className="segmented"
              role="group"
              aria-label="Transcript view"
            >
              <button
                className={!showSource ? "active" : ""}
                aria-pressed={!showSource}
                disabled={editing}
                onClick={() => setShowSource(false)}
              >
                Result
              </button>
              <button
                className={showSource ? "active" : ""}
                aria-pressed={showSource}
                disabled={editing}
                onClick={() => setShowSource(true)}
              >
                Speech
              </button>
            </div>
            <span className="caption">
              {showSource
                ? edited
                  ? "Your correction"
                  : "Original speech"
                : record.magicText
                  ? "Optional rewrite"
                  : "Corrections & shortcuts applied"}
            </span>
          </div>
          {editing ? (
            <textarea
              aria-label="Correct transcript"
              className={`transcript-editor w-full whitespace-pre-wrap wrap-anywhere text-[14px] leading-[1.8] ${
                inspector
                  ? "min-h-[260px] max-h-[460px] overflow-y-auto rounded-[5px] border border-line bg-input p-4 max-[1150px]:min-h-[120px]"
                  : "min-h-[150px] rounded-md bg-soft p-4"
              }`}
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
            <div
              className={`transcript-original w-full whitespace-pre-wrap wrap-anywhere text-[14px] leading-[1.8] ${
                inspector
                  ? "min-h-[260px] max-h-[460px] overflow-y-auto rounded-[5px] border border-line bg-input p-4 max-[1150px]:min-h-[120px]"
                  : "rounded-md bg-soft p-4"
              }`}
            >
              {text}
            </div>
          )}
          <div
            className={`detail-actions mt-3 ${
              inspector
                ? "gap-[3px] [&_.tool-button]:min-h-[30px] [&_.tool-button]:p-1.5 [&_.tool-button]:text-[10px] [&_svg]:size-[13px]"
                : ""
            }`}
          >
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
                    setShowSource(true);
                    setDraft(transcriptText(record));
                    setEditing(true);
                  }}
                >
                  <Pencil /> Edit
                </button>
                <button className="tool-button" onClick={() => onCopy(text)}>
                  <Copy /> Copy {showSource ? "speech" : "result"}
                </button>
                {edited && (
                  <button
                    className="tool-button"
                    onClick={() => void onUpdateTranscript(record.id, null)}
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
                          setShowSource(false);
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
            <div className="export-row mt-3.5 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[11px] text-muted [&_.tool-button]:min-h-[28px] [&_.tool-button]:px-2 [&_.tool-button]:py-[5px] [&_svg]:size-3">
              <span>Export</span>
              {(["txt", "json"] as ExportFormat[]).map((format) => (
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
            if (applied) setShowSource(false);
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
