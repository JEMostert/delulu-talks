import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  Check,
  Clipboard,
  Cpu,
  FileText,
  Gauge,
  Lightbulb,
  ListTree,
  LoaderCircle,
  RotateCcw,
  Sparkles,
  WandSparkles,
  Zap,
} from "lucide-react";
import { MAGIC_MODELS, magicModelById } from "../data";
import { transcriptText } from "../transcriptText";
import type {
  AppSettings,
  MagicPreset,
  MagicRewriteRequest,
  MagicRewriteResult,
  MagicStatus,
  TranscriptRecord,
} from "../types";

const PRESETS: Array<{
  id: MagicPreset;
  name: string;
  description: string;
  icon: typeof Sparkles;
}> = [
  {
    id: "polish",
    name: "Polish",
    description: "Natural, clean writing with the same meaning.",
    icon: Sparkles,
  },
  {
    id: "concise",
    name: "Concise",
    description: "Shorten it without losing decisions or facts.",
    icon: Zap,
  },
  {
    id: "structured",
    name: "Detailed",
    description: "Add structure and make relationships explicit.",
    icon: ListTree,
  },
  {
    id: "prompt",
    name: "Prompt builder",
    description: "Turn rough intent into actionable requirements.",
    icon: Lightbulb,
  },
];

const MAGIC_DRAFT_KEY = "delulu-magic-draft";

type SavedMagicDraft = {
  source: string;
  preset: MagicPreset;
  instructions: string;
  allowInferences: boolean;
  result: MagicRewriteResult | null;
};

function savedDraft(): Partial<SavedMagicDraft> {
  try {
    return JSON.parse(sessionStorage.getItem(MAGIC_DRAFT_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function MagicPage({
  settings,
  status,
  history,
  saving,
  onUpdateSettings,
  onSetup,
  onLoad,
  onUnload,
  onRewrite,
  onCopy,
  onToast,
}: {
  settings: AppSettings;
  status: MagicStatus;
  history: TranscriptRecord[];
  saving: boolean;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onSetup: () => void;
  onLoad: () => void;
  onUnload: () => void;
  onRewrite: (request: MagicRewriteRequest) => Promise<MagicRewriteResult>;
  onCopy: (text: string) => void;
  onToast: (message: string) => void;
}) {
  const latest = history[0];
  const latestText = latest ? transcriptText(latest) : "";
  const [initialDraft] = useState(savedDraft);
  const [source, setSource] = useState(initialDraft.source ?? latestText);
  const [preset, setPreset] = useState<MagicPreset>(
    initialDraft.preset ?? "polish",
  );
  const [instructions, setInstructions] = useState(
    initialDraft.instructions ?? "",
  );
  const [allowInferences, setAllowInferences] = useState(
    initialDraft.allowInferences ?? false,
  );
  const [result, setResult] = useState<MagicRewriteResult | null>(
    initialDraft.result ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const selectedModel = magicModelById(settings.magicModel);
  const busy = ["preparing", "loading", "rewriting"].includes(status.phase);
  const canRewrite =
    !busy &&
    !saving &&
    !["missing", "error"].includes(status.engine) &&
    source.trim().length > 0;
  const sourceWords = useMemo(
    () => (source.trim() ? source.trim().split(/\s+/).length : 0),
    [source],
  );

  useEffect(() => {
    try {
      sessionStorage.setItem(
        MAGIC_DRAFT_KEY,
        JSON.stringify({
          source,
          preset,
          instructions,
          allowInferences,
          result,
        } satisfies SavedMagicDraft),
      );
    } catch {
      /* The mounted workspace still retains the draft. */
    }
  }, [source, preset, instructions, allowInferences, result]);

  function choosePreset(next: MagicPreset) {
    setPreset(next);
  }

  async function rewrite() {
    if (!canRewrite) return;
    setError(null);
    try {
      setResult(
        await onRewrite({
          text: source,
          preset,
          instructions,
          allowInferences,
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function useLatest() {
    if (!latestText) return;
    setSource(latestText);
    setResult(null);
    onToast("Latest transcript loaded");
  }

  return (
    <div className="content-stack magic-page">
      <section className="view-toolbar magic-toolbar">
        <div>
          <strong>Local text rewriting</strong>
          <span>
            Everything runs locally · your source and output never leave this
            device
          </span>
        </div>
        <div
          className={`magic-runtime-chip phase-${status.phase} flex items-center gap-2 px-3 py-2 bg-accent-soft rounded-md backdrop-blur-md max-w-[250px]`}
        >
          <i className="size-[5px] rounded-full bg-accent shrink-0" />
          <span className="m-0">
            <strong className="text-[11px]">
              {selectedModel.parameters} · {status.engine}
            </strong>
            <small className="block text-[10px] overflow-hidden text-ellipsis whitespace-nowrap max-w-[200px]">
              {status.message}
            </small>
          </span>
        </div>
      </section>

      {["missing", "error"].includes(status.engine) && (
        <section className="magic-disabled flex gap-3.5 items-center p-5 bg-accent-soft rounded-xl backdrop-blur-md">
          <Cpu />
          <div className="flex-1">
            <strong className="text-[13px]">
              {status.engine === "error"
                ? "Writing engine error"
                : "Install the writing engine"}
            </strong>
            <p className="text-[12px] text-muted">
              {status.engine === "error"
                ? status.message
                : "Install the local writing model to start rewriting. Speech dictation works independently."}
            </p>
          </div>
          <button
            className="primary-button"
            disabled={busy || saving}
            onClick={onSetup}
          >
            <ArrowDownToLine />
            {status.engine === "error" ? "Repair Magic" : "Install Magic"}
          </button>
        </section>
      )}
      <div className="magic-layout grid gap-4 items-start grid-cols-[minmax(0,1fr)_245px] max-[1150px]:grid-cols-[minmax(0,1fr)_225px] max-[700px]:grid-cols-1">
        <section className="magic-editor-panel grid grid-cols-2 gap-3.5 rounded-panel overflow-hidden min-w-0 max-[1150px]:grid-cols-1">
          <section className="magic-source flex flex-col border border-line rounded-xl overflow-hidden bg-surface backdrop-blur-md min-w-0">
            <header className="panel-toolbar flex-wrap">
              <div>
                <strong>Source</strong>
                <span>
                  {sourceWords} words · {source.length.toLocaleString()}{" "}
                  characters
                </span>
              </div>
              <div className="panel-actions">
                <button
                  className="tool-button text-[11px]"
                  disabled={!latestText}
                  onClick={useLatest}
                >
                  <ArrowDownToLine /> Latest transcript
                </button>
                <button
                  className="icon-button"
                  aria-label="Clear source"
                  title="Clear source"
                  disabled={!source}
                  onClick={() => {
                    setSource("");
                    setResult(null);
                  }}
                >
                  <RotateCcw />
                </button>
              </div>
            </header>
            <textarea
              className="w-full min-h-[380px] max-[1150px]:min-h-[190px] border-0 rounded-none px-[18px] py-4 bg-transparent text-[14px] resize-y"
              aria-label="Text to rewrite"
              value={source}
              maxLength={50_000}
              onChange={(event) => setSource(event.target.value)}
              placeholder="Paste a rough draft here, or record something and load your latest transcript…"
            />
          </section>
          <section className="magic-output border border-line rounded-xl overflow-hidden bg-surface backdrop-blur-md min-w-0 min-h-[475px] max-[1150px]:min-h-[220px]">
            <header className="panel-toolbar flex-wrap">
              <div>
                <strong>Output</strong>
                <span>
                  {result
                    ? `${result.outputCharacters.toLocaleString()} characters · ${(result.processingTimeMs / 1000).toFixed(1)}s`
                    : "Your rewrite appears here"}
                </span>
              </div>
              {result && (
                <div className="panel-actions">
                  <span
                    className={`inference-badge ${result.includedInferences ? "on" : ""}`}
                  >
                    {result.includedInferences
                      ? "Review assumptions"
                      : "Preserve-facts mode"}
                  </span>
                  <button
                    className="tool-button"
                    onClick={() => {
                      setSource(result.text);
                      setResult(null);
                      onToast("Output moved to source");
                    }}
                  >
                    <FileText /> Use as source
                  </button>
                  <button
                    className="primary-button"
                    onClick={() => onCopy(result.text)}
                  >
                    <Clipboard /> Copy
                  </button>
                </div>
              )}
            </header>
            {result ? (
              <div
                className="magic-result px-[18px] py-4 whitespace-pre-wrap break-words text-[14px] leading-[1.85]"
                aria-live="polite"
              >
                {result.text}
              </div>
            ) : (
              <div className="magic-output-empty flex flex-col items-center gap-3.5 text-center px-6 py-10 text-muted">
                <Sparkles className="text-accent w-[25px] h-[25px]" />
                <p className="text-[12px] max-w-[250px]">
                  Choose a style and select Rewrite. The original stays in
                  Source.
                </p>
              </div>
            )}
          </section>
        </section>

        <aside
          className="magic-controls border border-line bg-surface rounded-panel shadow-panel backdrop-blur-xl overflow-hidden min-w-0 p-3.5 flex flex-col gap-4 max-[700px]:order-first"
          aria-label="Magic rewrite controls"
        >
          <button
            className="primary-button magic-submit w-full text-[12px]"
            disabled={!canRewrite}
            onClick={() => void rewrite()}
          >
            {busy ? <LoaderCircle className="spin" /> : <WandSparkles />}
            {status.phase === "rewriting"
              ? "Rewriting…"
              : status.phase === "loading" || status.phase === "preparing"
                ? status.message
                : "Rewrite"}
          </button>
          {error && (
            <p
              className="magic-error text-[12px] text-danger p-3 bg-danger-soft rounded-lg break-words"
              role="alert"
            >
              {error}
            </p>
          )}
          <section>
            <p className="eyebrow text-[9px] tracking-[1.2px]">WRITING STYLE</p>
            <div className="magic-presets flex flex-col gap-1.5 max-[700px]:grid max-[700px]:grid-cols-2">
              {PRESETS.map(({ id, name, description, icon: Icon }) => (
                <button
                  key={id}
                  className={
                    preset === id
                      ? "min-h-[42px] flex gap-2.5 items-center p-3 border border-accent rounded-md bg-accent-soft text-left"
                      : "min-h-[42px] flex gap-2.5 items-center p-3 border border-transparent rounded-md bg-soft text-left"
                  }
                  aria-pressed={preset === id}
                  onClick={() => choosePreset(id)}
                >
                  <Icon className="w-4 h-4 text-accent-ink" />
                  <span className="flex-1">
                    <strong className="block text-[12px]">{name}</strong>
                    <small className="hidden">{description}</small>
                  </span>
                  {preset === id && (
                    <Check className="w-4 h-4 text-accent-ink" />
                  )}
                </button>
              ))}
            </div>
          </section>

          <section>
            <p className="eyebrow text-[9px] tracking-[1.2px]">ADDED DETAIL</p>
            <div
              className="segmented magic-boundary w-full"
              role="group"
              aria-label="Accuracy boundary"
            >
              <button
                className={
                  !allowInferences
                    ? "px-1.5 py-[7px] text-[10px] flex-1 active"
                    : "px-1.5 py-[7px] text-[10px] flex-1"
                }
                aria-pressed={!allowInferences}
                onClick={() => setAllowInferences(false)}
              >
                Preserve facts
              </button>
              <button
                className={
                  allowInferences
                    ? "px-1.5 py-[7px] text-[10px] flex-1 active inferred"
                    : "px-1.5 py-[7px] text-[10px] flex-1"
                }
                aria-pressed={allowInferences}
                onClick={() => setAllowInferences(true)}
              >
                Allow assumptions
              </button>
            </div>
            <p
              className={
                allowInferences
                  ? "text-[11px] text-warning mt-2.5"
                  : "text-[11px] text-muted mt-2.5"
              }
            >
              {allowInferences
                ? "Magic may add useful constraints, examples, and implementation details. Review them before sending."
                : "Ask Magic to reorganize your words while preserving the facts. Review the result before sharing."}
            </p>
          </section>

          <label className="magic-instructions">
            <span className="eyebrow">YOUR INSTRUCTIONS</span>
            <textarea
              className="w-full min-h-[90px] text-[12px]"
              aria-label="Custom rewrite instructions"
              value={instructions}
              maxLength={4_000}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="e.g. Write for a senior engineer; keep the tone direct…"
            />
          </label>

          <details className="magic-model-control">
            <summary>Local writing model</summary>
            <label>
              <span className="block text-[9px] text-muted tracking-[1px] mb-[9px]">
                LOCAL MODEL
              </span>
              <select
                className="w-full text-[11px]"
                aria-label="Magic model"
                disabled={saving || busy}
                value={settings.magicModel}
                onChange={(event) =>
                  onUpdateSettings({
                    magicModel: event.target.value as AppSettings["magicModel"],
                  })
                }
              >
                {MAGIC_MODELS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name} · {model.role}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-2 mt-3 items-center">
              <Cpu className="text-muted w-3.5 h-3.5" />
              <span>
                <strong className="block text-[10px]">
                  {selectedModel.memory} resident
                </strong>
                <small className="block text-[10px]">
                  {selectedModel.speed} · Apache 2.0
                </small>
              </span>
            </div>
            <div className="magic-runtime-actions">
              {status.engine === "missing" || status.engine === "error" ? (
                <button
                  className="secondary-button"
                  disabled={busy || saving}
                  onClick={onSetup}
                >
                  <ArrowDownToLine /> Install model
                </button>
              ) : status.engine === "unloaded" ? (
                <button
                  className="secondary-button"
                  disabled={busy || saving}
                  onClick={onLoad}
                >
                  <Gauge /> Load model
                </button>
              ) : status.engine === "ready" ? (
                <button
                  className="secondary-button"
                  disabled={busy || saving}
                  onClick={onUnload}
                >
                  Unload
                </button>
              ) : null}
            </div>
          </details>
        </aside>
      </div>
    </div>
  );
}
