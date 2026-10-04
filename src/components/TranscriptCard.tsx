import { CaptureDiagnostics } from "./CaptureDiagnostics";
import { ExportTemplateDialog } from "./ExportTemplateDialog";
import type { ExportTemplateRequest } from "../exportTemplates";
import { PipelineTimingDetails } from "./PipelineTimingDetails";
import { TechnicalAddressPreview } from "./TechnicalAddressPreview";
import { RewriteDialog } from "./RewriteDialog";
import { IdentifierPreview } from "./IdentifierPreview";
import { FillerPreview } from "./FillerPreview";
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
  MoreHorizontal,
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
import { ConfirmDialog, MenuButton, Modal } from "./ui";
import type {
  MagicRewriteRequest,
  MagicRewriteResult,
  MagicStatus,
  CustomWord,
  ExportFormat,
  TranscriptRecord,
} from "../types";

export type TranscriptActions = {
  onOpenRewrite?: (record: TranscriptRecord) => void;
  onRewrite?: (request: MagicRewriteRequest) => Promise<MagicRewriteResult>;
  onCancelRewrite?: (operationId: string) => Promise<boolean>;
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
  variant = "card",
  onCopy,
  onUpdateTranscript,
  onSetTitle,
  onDelete,
  onExport,
  onExportTemplate,
  onRemember,
  ruleExamples,
  onRewrite,
  onOpenRewrite,
  onCancelRewrite,
  onSetRewrite,
  onRewriteSetup,
  rewriteStatus,
}: TranscriptActions & {
  record: TranscriptRecord;
  /** "detail" is always expanded, for the History list/detail layout. */
  variant?: "card" | "detail";
}) {
  const pendingDraft = useCorrectionDraft(record.id);
  const [expanded, setOpen] = useState(!!pendingDraft);
  const open = variant === "detail" || expanded;
  const [templateExport, setTemplateExport] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [identifierPreview, setIdentifierPreview] = useState(false);
  const [fillerPreview, setFillerPreview] = useState(false);

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
  const previousRewrite = useRef(record.magicText);
  useEffect(() => {
    if (previousRewrite.current !== record.magicText) setShowSource(false);
    previousRewrite.current = record.magicText;
  }, [record.magicText]);
  useEffect(() => {
    setEditing(!!pendingDraft);
    setOpen(!!pendingDraft);
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
  const words = delivered.trim().split(/\s+/).filter(Boolean).length;
  const undoRewrite = async () => {
    if (!onSetRewrite) return;
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
  };
  const openRemember = () => {
    if (!correctionSuggested) {
      setHeard(window.getSelection()?.toString().trim().slice(0, 256) ?? "");
      setCorrect("");
    }
    setRemember(true);
  };
  const unsaved =
    pendingDraft &&
    (pendingDraft.error || pendingDraft.text.trim() !== transcriptText(record));
  const delivery =
    record.delivery?.state === "paste-attempted"
      ? "Paste attempted · destination unconfirmed"
      : record.delivery?.state === "confirmed"
        ? "Delivered"
        : record.delivery?.state === "copied"
          ? "Copied to clipboard"
          : record.delivery?.state === "transcribed"
            ? "Transcribed, not delivered"
            : "Not recorded";
  const language =
    record.recognizedLanguage !== undefined ||
    record.requestedLanguage !== undefined ||
    record.languageStatus !== undefined
      ? `${
          languageMetadata.languageStatus === "mixed"
            ? `Mixed (${languageMetadata.recognizedLanguages.join(", ")})`
            : languageMetadata.recognizedLanguage || "Unknown"
        } · hint ${record.requestedLanguage || "not recorded"}`
      : record.language || "Unknown";
  return (
    <article
      className={`transcript-card ${variant === "detail" ? "transcript-full" : "card"} ${open ? "expanded" : ""}`}
    >
      <header className="transcript-head">
        <span className="transcript-icon" aria-hidden="true">
          {record.source === "dictation" ? <Mic /> : <FileAudio />}
        </span>
        <div className="transcript-meta">
          <strong>{record.title || record.sourceName || "Dictation"}</strong>
          <span>
            {date} · {Math.max(1, Math.round(record.durationMs / 1000))}s
            {record.dictationMode && record.dictationMode !== "prose"
              ? record.dictationMode === "code"
                ? " · Code"
                : " · Command"
              : ""}
            {record.title &&
            record.sourceName &&
            record.title !== record.sourceName
              ? ` · ${record.sourceName}`
              : ""}
          </span>
        </div>
        <div className="transcript-badges">
          {unsaved && <span className="badge warning">Unsaved draft</span>}
          {record.magicText && (
            <span className="badge">
              <WandSparkles aria-hidden="true" /> Rewritten
            </span>
          )}
          {edited && <span className="badge neutral">Corrected</span>}
        </div>
        <div className="transcript-actions">
          <button
            className="sheet-icon"
            aria-label="Copy delivered text"
            title="Copy"
            onClick={() => onCopy(deliveredText(record))}
          >
            <Copy />
          </button>
          {onSetTitle && (
            <button
              className="sheet-icon"
              aria-label={
                record.title ? "Edit transcript title" : "Add transcript title"
              }
              title={record.title ? "Rename" : "Add a title"}
              disabled={saving}
              onClick={() => setNaming(true)}
            >
              <Pencil />
            </button>
          )}
          {onDelete && (
            <button
              className="sheet-icon danger"
              aria-label="Delete transcript"
              title="Delete"
              onClick={() => setDeleting(true)}
            >
              <Trash2 />
            </button>
          )}
        </div>
      </header>
      {!open && <p className="transcript-preview">{delivered}</p>}
      <footer className="transcript-foot" hidden={variant === "detail"}>
        <span className="caption">
          {words} {words === 1 ? "word" : "words"}
          {record.magicIncludedInferences ? " · assumptions allowed" : ""}
        </span>
        <button
          className="text-button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide details" : "Review"}
          <ChevronDown
            aria-hidden="true"
            className={`size-[14px] transition-transform ${open ? "rotated" : ""}`}
          />
        </button>
      </footer>
      {open && (
        <div className="transcript-detail">
          <div className="transcript-view">
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
                  ? "Rewritten result"
                  : "Corrections and shortcuts applied"}
            </span>
          </div>
          {pendingDraft?.error && (
            <p className="field-error" role="alert">
              {pendingDraft.error}
            </p>
          )}
          {pendingDraft &&
            pendingDraft.savedText !== transcriptText(record) && (
              <p className="caption">
                The saved transcript changed while this draft was open. Review
                the current speech before replacing it.
              </p>
            )}
          {!editing &&
            record.dictationMode &&
            record.dictationMode !== "prose" && (
              <TechnicalAddressPreview
                key={record.id}
                speech={record.text}
                onCopy={onCopy}
              />
            )}
          {editing ? (
            <textarea
              aria-label="Correct transcript"
              className="transcript-editor"
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
            <div className="transcript-text well">{text}</div>
          )}
          <div className="detail-actions">
            {editing ? (
              <>
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
                <span className="caption">Ctrl+Enter saves · Esc closes</span>
              </>
            ) : (
              <>
                <button className="primary-button" onClick={() => onCopy(text)}>
                  <Copy /> Copy {showSource ? "speech" : "result"}
                </button>
                <button
                  className="secondary-button"
                  onClick={() => {
                    setShowSource(true);
                    setEditSource(
                      pendingDraft?.savedText ?? transcriptText(record),
                    );
                    if (!pendingDraft) setDraft(transcriptText(record));
                    setEditing(true);
                  }}
                >
                  <Pencil /> {pendingDraft ? "Resume correction" : "Correct"}
                </button>
                {onRewrite && onSetRewrite && (
                  <button
                    className="secondary-button"
                    disabled={saving}
                    onClick={() =>
                      onOpenRewrite ? onOpenRewrite(record) : setRewriting(true)
                    }
                  >
                    <WandSparkles /> Rewrite
                  </button>
                )}
                <MenuButton
                  label="More actions"
                  icon={MoreHorizontal}
                  items={[
                    ...(record.magicText && onSetRewrite
                      ? [
                          {
                            label: "Undo rewrite",
                            icon: RotateCcw,
                            disabled: saving,
                            onSelect: () => void undoRewrite(),
                          },
                        ]
                      : []),
                    ...(edited
                      ? [
                          {
                            label: "Restore original",
                            icon: RotateCcw,
                            onSelect: () =>
                              void onUpdateTranscript(record.id, null),
                          },
                        ]
                      : []),
                    ...(onRemember
                      ? [
                          {
                            label: "Remember a correction…",
                            icon: BookPlus,
                            onSelect: openRemember,
                          },
                        ]
                      : []),
                    {
                      label: "Remove filler words…",
                      disabled:
                        saving || transcriptText(record).length > 50_000,
                      onSelect: () => setFillerPreview(true),
                    },
                    {
                      label: "Identifiers…",
                      onSelect: () => setIdentifierPreview(true),
                    },
                    ...(onExport
                      ? (["txt", "md", "json"] as ExportFormat[]).map(
                          (format, index) => ({
                            label: `Export ${format === "md" ? "Markdown" : format.toUpperCase()}`,
                            icon: Download,
                            separated: index === 0,
                            onSelect: () => onExport(record.id, format),
                          }),
                        )
                      : []),
                    ...(onExport && onExportTemplate
                      ? [
                          {
                            label: "Export with template…",
                            icon: Download,
                            onSelect: () => setTemplateExport(true),
                          },
                        ]
                      : []),
                  ]}
                />
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
          {record.dictationFormatting === "spoken" && (
            <p className="caption">
              Spoken formatting commands were applied; the original recognition
              is under Speech.
            </p>
          )}
          <details className="disclosure transcript-facts">
            <summary>Details</summary>
            <dl>
              <dt>Delivery</dt>
              <dd title={record.delivery?.detail}>{delivery}</dd>
              <dt>Language</dt>
              <dd title="The backend label may reflect a forced decoder hint; it is not an independent language detection.">
                {language}
              </dd>
              <dt>Confidence</dt>
              <dd>No calibrated score — review the text before using it.</dd>
            </dl>
            <CaptureDiagnostics value={record.captureDiagnostics} />
            <PipelineTimingDetails timings={record.timings} />
          </details>
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
          onCancelRewrite={onCancelRewrite}
          onApply={async (result, source, revision) => {
            const applied = await onSetRewrite(
              record.id,
              result,
              source,
              revision,
            );
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
      {fillerPreview && (
        <FillerPreview
          text={transcriptText(record)}
          onClose={() => setFillerPreview(false)}
          onDraft={(source, result) => {
            setFillerPreview(false);
            setShowSource(true);
            setEditSource(source);
            setDraft(result);
            setEditing(true);
          }}
        />
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
          <SuggestedRulePreview
            source={record}
            examples={ruleExamples}
            heard={heard}
            correct={correct}
          />
        </Modal>
      )}
      {identifierPreview && (
        <IdentifierPreview
          source={transcriptText(record)}
          onCopy={onCopy}
          onClose={() => setIdentifierPreview(false)}
        />
      )}
    </article>
  );
}
