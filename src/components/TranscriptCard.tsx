import { CaptureDiagnostics } from "./CaptureDiagnostics";
import { ExportTemplateDialog } from "./ExportTemplateDialog";
import type { ExportTemplateRequest } from "../exportTemplates";
import { RewriteDialog } from "./RewriteDialog";
import { normalizeLanguageMetadata } from "../transcriptLanguage";
import { correctionSuggestion } from "../correctionSuggestion";
import { useEffect, useRef, useState } from "react";
import {
  discardCorrectionDraft,
  failCorrectionDraft,
  useCorrectionDraft,
  writeCorrectionDraft,
} from "../correctionDrafts";
import { TranscriptTitleDialog } from "./TranscriptTitleDialog";
import { SuggestedRulePreview } from "./SuggestedRulePreview";
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
  transcriptSourceRevision,
} from "../transcriptText";
import { normalizeRuleLanguage } from "../personalization";
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
    expectedSourceRevision?: number,
  ) => Promise<boolean>;
  onRewriteSetup?: () => void;
  rewriteStatus?: MagicStatus;
  onCopy: (text: string) => void;
  onUpdateTranscript: (id: string, text: string | null) => Promise<boolean>;
  onSetTitle?: (id: string, title: string | null) => Promise<boolean>;
  onDelete?: (id: string) => void;
  onExport?: (id: string, format: ExportFormat) => void;
  onExportTemplate?: (
    id: string,
    request: ExportTemplateRequest,
  ) => Promise<string | null>;
  onRemember?: (word: CustomWord) => Promise<boolean>;
  ruleExamples?: TranscriptRecord[];
};
export function TranscriptCard({
  record,
  defaultOpen = false,
  inspector = false,
  onCopy,
  onUpdateTranscript,
  onSetTitle,
  onDelete,
  onExport,
  onExportTemplate,
  onRemember,
  ruleExamples,
  onRewrite,
  onSetRewrite,
  onRewriteSetup,
  rewriteStatus,
}: TranscriptActions & {
  record: TranscriptRecord;
  defaultOpen?: boolean;
  inspector?: boolean;
}) {
  const pendingDraft = useCorrectionDraft(record.id);
  const [open, setOpen] = useState(defaultOpen || inspector || !!pendingDraft);
  const [templateExport, setTemplateExport] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [correctionSuggested, setCorrectionSuggested] = useState(false);
  const [editing, setEditing] = useState(!!pendingDraft);
  const draft = pendingDraft?.text ?? "";
  const setDraft = (value: string) =>
    writeCorrectionDraft(record.id, value, transcriptText(record));
  const [editSource, setEditSource] = useState(pendingDraft?.savedText ?? "");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const recordIdRef = useRef(record.id);
  recordIdRef.current = record.id;
  const [deleting, setDeleting] = useState(false);
  const [rememberError, setRememberError] = useState<string | null>(null);
  const [remember, setRemember] = useState(false);
  const [heard, setHeard] = useState("");
  const [correct, setCorrect] = useState("");
  const languageMetadata = normalizeLanguageMetadata(record);
  const [naming, setNaming] = useState(false);
  const delivered = deliveredText(record);
  const edited = transcriptIsEdited(record);
  const text = showSource ? transcriptText(record) : delivered;
  useEffect(() => {
    setEditing(!!pendingDraft);
    setOpen(defaultOpen || inspector || !!pendingDraft);
    setShowSource(!!pendingDraft);
  }, [record.id]);
  const date = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(record.createdAt);
  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if (await onUpdateTranscript(record.id, draft)) {
        discardCorrectionDraft(record.id);
        if (recordIdRef.current !== record.id) return;
        setEditing(false);
        const suggestion = correctionSuggestion(editSource, draft);
        setCorrectionSuggested(!!suggestion);
        setHeard(suggestion?.heard ?? "");
        setCorrect(suggestion?.correct ?? "");
      } else {
        failCorrectionDraft(
          record.id,
          "The correction was not saved. Your draft is kept in this session; retry saving or discard it.",
        );
      }
    } catch (reason) {
      failCorrectionDraft(
        record.id,
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      savingRef.current = false;
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
        <div className="transcript-meta flex-1 min-w-0">
          <strong className="block text-[12px] wrap-anywhere">
            {record.title || record.sourceName || "Dictation"}
          </strong>
          {pendingDraft &&
            (pendingDraft.error || pendingDraft.text.trim() !== transcriptText(record)) && (
              <span className="text-[10px] text-muted">
                Unsaved correction · session only
              </span>
            )}
          {record.title &&
            record.sourceName &&
            record.title !== record.sourceName && (
              <span className="block text-[10px] text-muted wrap-anywhere">
                {record.sourceName}
              </span>
            )}
          <span className="mt-[3px] flex items-center gap-1 text-[10px] text-muted">
            {date} · {Math.max(1, Math.round(record.durationMs / 1000))}s{" "}
            {record.magicText && (
              <>
                · <WandSparkles className="size-[11px]" /> Rewritten
              </>
            )}
          </span>
          <span
            className="mt-1 block text-[10px] text-muted break-words"
            aria-label="Transcript language metadata"
            title="The backend language label may reflect a forced decoder hint; it is not an independent language detection result."
          >
            {record.recognizedLanguage !== undefined ||
            record.requestedLanguage !== undefined ||
            record.languageStatus !== undefined ? (
              <>
                {languageMetadata.languageStatus === "mixed"
                  ? `Backend languages: Mixed (${languageMetadata.recognizedLanguages.join(", ")})`
                  : `Backend language: ${languageMetadata.recognizedLanguage || "Unknown"}`}
                {" · "}Requested hint:{" "}
                {record.requestedLanguage || "Not recorded"}
              </>
            ) : (
              <>Legacy language: {record.language || "Unknown"}</>
            )}
          </span>
        </div>
        <div className="panel-actions">
          {onSetTitle && (
            <button
              className="icon-button"
              aria-label={
                record.title ? "Edit transcript title" : "Add transcript title"
              }
              title={
                record.title ? "Edit transcript title" : "Add transcript title"
              }
              disabled={saving}
              onClick={() => setNaming(true)}
            >
              <Pencil />
            </button>
          )}
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
      {open && <CaptureDiagnostics value={record.captureDiagnostics} />}
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
              ? " · Added assumptions were allowed"
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
          {pendingDraft?.error && (
            <p className="field-error" role="alert">
              {pendingDraft.error}
            </p>
          )}
          {pendingDraft && pendingDraft.savedText !== transcriptText(record) && (
            <p className="caption">
              The saved transcript changed while this draft was open. Review
              the current speech before replacing it.
            </p>
          )}
          <p className="caption mt-2.5">
            No calibrated confidence score is available for this transcript.
            Review the text before using it.
          </p>
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
              disabled={saving}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (savingRef.current) return;
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
                  onClick={() => {
                    discardCorrectionDraft(record.id);
                    setEditing(false);
                  }}
                >
                  Discard draft
                </button>
                <button
                  className="primary-button"
                  disabled={
                    saving ||
                    !draft.trim() ||
                    (!pendingDraft?.error &&
                      draft.trim() === transcriptText(record))
                  }
                  onClick={() => void save()}
                >
                  <Check />
                  {saving
                    ? "Saving…"
                    : pendingDraft?.error
                      ? "Retry saving"
                      : "Save correction"}
                </button>
              </>
            ) : (
              <>
                <button
                  className="tool-button"
                  onClick={() => {
                    setShowSource(true);
                    setEditSource(pendingDraft?.savedText ?? transcriptText(record));
                    if (!pendingDraft) setDraft(transcriptText(record));
                    setEditing(true);
                  }}
                >
                  <Pencil /> {pendingDraft ? "Resume correction" : "Edit"}
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
                            transcriptSourceRevision(record),
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
              {(["txt", "json", "md"] as ExportFormat[]).map((format) => (
                <button
                  className="tool-button"
                  key={format}
                  onClick={() => onExport(record.id, format)}
                >
                  <Download />
                  {format === "md" ? "Markdown" : format.toUpperCase()}
                </button>
              ))}
              {onExportTemplate && (
                <button
                  className="tool-button"
                  onClick={() => setTemplateExport(true)}
                >
                  <Download /> Template…
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {templateExport && onExportTemplate && (
        <ExportTemplateDialog
          record={record}
          onClose={() => setTemplateExport(false)}
          onExport={(request) => onExportTemplate(record.id, request)}
        />
      )}
      {rewriting && onRewrite && onSetRewrite && (
        <RewriteDialog
          text={text}
          baseline={deliveredText(record)}
          sourceRevision={transcriptSourceRevision(record)}
          sourceLanguage={record.language}
          status={rewriteStatus}
          onClose={() => setRewriting(false)}
          onSetup={onRewriteSetup ?? (() => {})}
          onRewrite={onRewrite}
          onApply={async (result, source, revision) => {
            const applied = await onSetRewrite(record.id, result, source, revision);
            if (applied) setShowSource(false);
            return applied;
          }}
        />
      )}
      {naming && onSetTitle && (
        <TranscriptTitleDialog
          title={record.title ?? null}
          onClose={() => setNaming(false)}
          onSave={(title) => onSetTitle(record.id, title)}
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
                        language: normalizeRuleLanguage(record.language),
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
            <p className="field-error break-words" role="alert">
              {rememberError}
            </p>
          )}
          <p>
            Replace this recognized phrase in future {record.language} results.
            You can change its language scope in Vocabulary. This does not train
            the speech model.
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
          <SuggestedRulePreview source={record} examples={ruleExamples} heard={heard} correct={correct} />
        </Modal>
      )}
    </article>
  );
}
