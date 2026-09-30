import { useMemo, useRef, useState } from "react";
import { Download, LoaderCircle } from "lucide-react";
import {
  defaultExportTextSource,
  EXPORT_TEMPLATE_PRESETS,
  EXPORT_TEMPLATE_TOKENS,
  exportTemplateText,
  MAX_EXPORT_TEMPLATE_LENGTH,
  renderExportTemplate,
  type ExportTemplateRequest,
  type ExportTemplateSpec,
  type ExportTextSource,
} from "../exportTemplates";
import type { TranscriptRecord } from "../types";
import { Modal } from "./ui";

const errorMessage = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

export function ExportTemplateDialog({
  record,
  onClose,
  onExport,
}: {
  record: TranscriptRecord;
  onClose: () => void;
  onExport: (request: ExportTemplateRequest) => Promise<string | null>;
}) {
  const firstPreset = EXPORT_TEMPLATE_PRESETS[0];
  const [source, setSource] = useState<ExportTextSource>(() =>
    defaultExportTextSource(record),
  );
  const [preset, setPreset] = useState<string>(firstPreset?.id ?? "custom");
  const [template, setTemplate] = useState<string>(
    firstPreset?.template ?? "{{text}}",
  );
  const [extension, setExtension] = useState<ExportTemplateSpec["extension"]>(
    firstPreset?.extension ?? "txt",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exporting = useRef(false);
  const versions: Array<{
    value: ExportTextSource;
    label: string;
    available: boolean;
  }> = [
    { value: "original", label: "Original speech", available: true },
    {
      value: "corrected",
      label: "Corrected text",
      available: record.editedText != null,
    },
    {
      value: "personalized",
      label: "Personalized text",
      available: record.personalizedText != null,
    },
    {
      value: "rewritten",
      label: "Rewritten text",
      available: record.magicText != null,
    },
  ];
  const preview = useMemo(() => {
    let sourceText = "";
    try {
      sourceText = exportTemplateText(record, source);
      return {
        sourceText,
        output: renderExportTemplate(record, { template, source, extension }),
        error: null,
      };
    } catch (reason) {
      return { sourceText, output: "", error: errorMessage(reason) };
    }
  }, [record, source, template, extension]);

  const close = () => {
    if (!exporting.current) onClose();
  };
  const save = async () => {
    if (exporting.current || preview.error) return;
    exporting.current = true;
    setBusy(true);
    setError(null);
    try {
      const path = await onExport({
        template,
        source,
        extension,
        expectedOutput: preview.output,
      });
      if (path) onClose();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      exporting.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Export with template"
      busy={busy}
      onClose={close}
      footer={
        <>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy || preview.error !== null}
            onClick={() => void save()}
          >
            {busy ? <LoaderCircle className="spin" /> : <Download />}
            {busy ? "Saving export…" : "Export file"}
          </button>
        </>
      }
    >
      <p>
        Choose a transcript version and preview the exact text to save. Your
        transcript stays unchanged.
      </p>
      <div className="my-4 grid grid-cols-2 items-end gap-4 max-[600px]:grid-cols-1">
        <label className="field">
          Transcript version
          <select
            aria-label="Export transcript version"
            value={source}
            disabled={busy}
            onChange={(event) => {
              setSource(event.target.value as ExportTextSource);
              setError(null);
            }}
          >
            {versions
              .filter(
                (version) => version.available || version.value === source,
              )
              .map((version) => (
                <option
                  key={version.value}
                  value={version.value}
                  disabled={!version.available}
                >
                  {version.label}
                  {!version.available ? " (no longer available)" : ""}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          File format
          <select
            aria-label="Export file format"
            value={extension}
            disabled={busy}
            onChange={(event) => {
              setExtension(
                event.target.value as ExportTemplateSpec["extension"],
              );
              setError(null);
            }}
          >
            <option value="txt">Plain text (.txt)</option>
            <option value="md">Markdown (.md)</option>
          </select>
        </label>
      </div>
      <label className="field">
        Template preset
        <select
          aria-label="Export template preset"
          value={preset}
          disabled={busy}
          onChange={(event) => {
            const selected = EXPORT_TEMPLATE_PRESETS.find(
              (item) => item.id === event.target.value,
            );
            setPreset(event.target.value);
            if (selected) {
              setTemplate(selected.template);
              setExtension(selected.extension);
            }
            setError(null);
          }}
        >
          {EXPORT_TEMPLATE_PRESETS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
          <option value="custom">Custom template</option>
        </select>
      </label>
      <label className="field mt-3">
        Template
        <textarea
          aria-label="Export template"
          className="min-h-[140px] w-full"
          maxLength={MAX_EXPORT_TEMPLATE_LENGTH}
          spellCheck={false}
          disabled={busy}
          value={template}
          onChange={(event) => {
            setTemplate(event.target.value);
            setPreset("custom");
            setError(null);
          }}
        />
      </label>
      <p className="caption my-3">
        Include <code>{"{{text}}"}</code> for your selected transcript.
        Available placeholders:{" "}
        {EXPORT_TEMPLATE_TOKENS.map((token) => `{{${token}}}`).join(", ")}.
        Other text stays literal. Templates stay in this dialog for this
        session.
      </p>
      <div className="my-4 grid grid-cols-2 gap-4 max-[600px]:grid-cols-1">
        <label className="field">
          Selected transcript
          <textarea
            aria-label="Export selected transcript"
            className="min-h-[180px] w-full"
            readOnly
            spellCheck={false}
            value={preview.sourceText}
          />
        </label>
        <label className="field">
          Export preview
          <textarea
            aria-label="Export preview"
            className="min-h-[180px] w-full"
            readOnly
            spellCheck={false}
            value={preview.output}
          />
        </label>
      </div>
      {(preview.error || error) && (
        <p className="field-error" role="alert">
          {preview.error || error}
        </p>
      )}
    </Modal>
  );
}
