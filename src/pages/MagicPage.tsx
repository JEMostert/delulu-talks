import { useEffect, useMemo, useState } from "react";
import { ArrowDownToLine, Check, Clipboard, Cpu, FileText, Gauge, Lightbulb, ListTree, LoaderCircle, RotateCcw, Sparkles, WandSparkles, Zap } from "lucide-react";
import { MAGIC_MODELS, magicModelById } from "../data";
import { transcriptText } from "../transcriptText";
import type { AppSettings, MagicPreset, MagicRewriteRequest, MagicRewriteResult, MagicStatus, TranscriptRecord } from "../types";

const PRESETS: Array<{ id: MagicPreset; name: string; description: string; icon: typeof Sparkles }> = [
  { id: "polish", name: "Polish", description: "Natural, clean writing with the same meaning.", icon: Sparkles },
  { id: "concise", name: "Concise", description: "Shorten it without losing decisions or facts.", icon: Zap },
  { id: "structured", name: "Detailed", description: "Add structure and make relationships explicit.", icon: ListTree },
  { id: "prompt", name: "Prompt builder", description: "Turn rough intent into actionable requirements.", icon: Lightbulb },
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

export function MagicPage({ settings, status, history, saving, onUpdateSettings, onSetup, onLoad, onUnload, onRewrite, onCopy, onToast }: {
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
  const latestText = latest ? transcriptText(latest, "intended") : "";
  const [initialDraft] = useState(savedDraft);
  const [source, setSource] = useState(initialDraft.source ?? latestText);
  const [preset, setPreset] = useState<MagicPreset>(initialDraft.preset ?? "polish");
  const [instructions, setInstructions] = useState(initialDraft.instructions ?? "");
  const [allowInferences, setAllowInferences] = useState(initialDraft.allowInferences ?? false);
  const [result, setResult] = useState<MagicRewriteResult | null>(initialDraft.result ?? null);
  const [error, setError] = useState<string | null>(null);
  const selectedModel = magicModelById(settings.magicModel);
  const busy = ["preparing", "loading", "rewriting"].includes(status.phase);
  const canRewrite = settings.magicEnabled && !busy && source.trim().length > 0;
  const sourceWords = useMemo(() => source.trim() ? source.trim().split(/\s+/).length : 0, [source]);

  useEffect(() => {
    if (!source && latestText) setSource(latestText);
  }, [latestText, source]);

  useEffect(() => {
    sessionStorage.setItem(MAGIC_DRAFT_KEY, JSON.stringify({ source, preset, instructions, allowInferences, result } satisfies SavedMagicDraft));
  }, [source, preset, instructions, allowInferences, result]);

  function choosePreset(next: MagicPreset) {
    setPreset(next);
    setAllowInferences(next === "prompt");
  }

  async function rewrite() {
    if (!canRewrite) return;
    setError(null);
    try {
      setResult(await onRewrite({ text: source, preset, instructions, allowInferences }));
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
        <div><strong>From rough speech to finished writing</strong><span>Everything runs locally · your source and output never leave this device</span></div>
        <div className={`magic-runtime-chip phase-${status.phase}`}><i /><span><strong>{selectedModel.parameters} · {status.engine}</strong><small>{status.message}</small></span></div>
      </section>

      {!settings.magicEnabled && <section className="magic-disabled"><WandSparkles /><div><strong>Magic is turned off</strong><p>Enable the local writing model to rewrite transcripts and drafts.</p></div><button className="primary-button" disabled={saving} onClick={() => onUpdateSettings({ magicEnabled: true })}><WandSparkles /> Enable Magic</button></section>}

      <div className="magic-layout">
        <section className="magic-editor-panel">
          <header className="panel-toolbar"><div><strong>Source</strong><span>{sourceWords} words · {source.length.toLocaleString()} characters</span></div><div className="panel-actions"><button className="tool-button" disabled={!latestText} onClick={useLatest}><ArrowDownToLine /> Latest transcript</button><button className="icon-button" aria-label="Clear source" title="Clear source" disabled={!source} onClick={() => { setSource(""); setResult(null); }}><RotateCcw /></button></div></header>
          <textarea aria-label="Text to rewrite" value={source} maxLength={50_000} onChange={(event) => setSource(event.target.value)} placeholder="Paste a rough draft here, or record something and load your latest transcript…" />
          <section className="magic-output">
            <header className="panel-toolbar"><div><strong>Magic output</strong><span>{result ? `${result.outputCharacters.toLocaleString()} characters · ${(result.processingTimeMs / 1000).toFixed(1)}s` : "Your rewrite appears here"}</span></div>{result && <div className="panel-actions"><span className={`inference-badge ${result.includedInferences ? "on" : ""}`}>{result.includedInferences ? "Review assumptions" : "Facts preserved"}</span><button className="tool-button" onClick={() => { setSource(result.text); setResult(null); onToast("Output moved to source"); }}><FileText /> Use as source</button><button className="primary-button" onClick={() => onCopy(result.text)}><Clipboard /> Copy</button></div>}</header>
            {result ? <div className="magic-result" aria-live="polite">{result.text}</div> : <div className="magic-output-empty"><Sparkles /><p>Choose a rewrite style, set the accuracy boundary, then run Magic.</p></div>}
          </section>
        </section>

        <aside className="magic-controls" aria-label="Magic rewrite controls">
          <section>
            <p className="eyebrow">1 / CHOOSE A REWRITE</p>
            <div className="magic-presets">
              {PRESETS.map(({ id, name, description, icon: Icon }) => <button key={id} className={preset === id ? "active" : ""} aria-pressed={preset === id} onClick={() => choosePreset(id)}><Icon /><span><strong>{name}</strong><small>{description}</small></span>{preset === id && <Check />}</button>)}
            </div>
          </section>

          <section>
            <p className="eyebrow">2 / ACCURACY BOUNDARY</p>
            <div className="segmented magic-boundary" role="group" aria-label="Accuracy boundary"><button className={!allowInferences ? "active" : ""} aria-pressed={!allowInferences} onClick={() => setAllowInferences(false)}>Preserve facts</button><button className={allowInferences ? "active inferred" : ""} aria-pressed={allowInferences} onClick={() => setAllowInferences(true)}>Allow assumptions</button></div>
            <p className={`boundary-note ${allowInferences ? "warning" : ""}`}>{allowInferences ? "Magic may add useful constraints, examples, and implementation details. Review them before sending." : "Magic will reorganize your words without introducing new facts or requirements."}</p>
          </section>

          <label className="magic-instructions"><span className="eyebrow">3 / OPTIONAL STYLE NOTE</span><textarea aria-label="Custom rewrite instructions" value={instructions} maxLength={4_000} onChange={(event) => setInstructions(event.target.value)} placeholder="e.g. Write for a senior engineer; keep the tone direct…" /></label>

          <section className="magic-model-control">
            <label><span>LOCAL MODEL</span><select aria-label="Magic model" disabled={saving || busy} value={settings.magicModel} onChange={(event) => onUpdateSettings({ magicModel: event.target.value as AppSettings["magicModel"] })}>{MAGIC_MODELS.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.role}</option>)}</select></label>
            <div><Cpu /><span><strong>{selectedModel.memory} resident</strong><small>{selectedModel.speed} · Apache 2.0</small></span></div>
            <div className="magic-runtime-actions">
              {status.engine === "missing" || status.engine === "error" ? <button className="secondary-button" disabled={busy || !settings.magicEnabled} onClick={onSetup}><ArrowDownToLine /> Install model</button> : status.engine === "unloaded" ? <button className="secondary-button" disabled={busy} onClick={onLoad}><Gauge /> Load model</button> : status.engine === "ready" ? <button className="secondary-button" disabled={busy} onClick={onUnload}>Unload</button> : null}
            </div>
          </section>

          <button className="primary-button magic-submit" disabled={!canRewrite} onClick={() => void rewrite()}>{busy ? <LoaderCircle className="spin" /> : <WandSparkles />}{status.phase === "rewriting" ? "Rewriting…" : status.phase === "loading" || status.phase === "preparing" ? status.message : "Rewrite with Magic"}</button>
          {error && <p className="magic-error" role="alert">{error}</p>}
        </aside>
      </div>

    </div>
  );
}
