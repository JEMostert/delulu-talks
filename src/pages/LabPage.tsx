import { useState } from "react";
import { AlignLeft, Check, Clock3, Copy, FileAudio, Fingerprint, LoaderCircle, ScanText, Sparkles, Upload } from "lucide-react";
import { bridge } from "../bridge";
import type { AppSettings, AudioFileSelection, LabOperation, TranscriptRecord, TranscriptionMode } from "../types";

const operations: Array<{ id: LabOperation; icon: typeof FileAudio; title: string; description: string }> = [
  { id: "transcribe", icon: ScanText, title: "Transcribe", description: "Create intended, verbatim, or paired transcripts with word timing." },
  { id: "verbatimize", icon: Fingerprint, title: "Verbatimize", description: "Use audio to restore fillers, repairs, and vocal events to a trusted clean transcript." },
  { id: "forcedAlign", icon: AlignLeft, title: "Forced align", description: "Attach precise word timestamps to an exact transcript you already trust." },
];

export function LabPage({ settings, onResult, onToast }: { settings: AppSettings; onResult: (record: TranscriptRecord) => void; onToast: (message: string) => void }) {
  const [file, setFile] = useState<AudioFileSelection | null>(null);
  const [operation, setOperation] = useState<LabOperation>("transcribe");
  const [mode, setMode] = useState<TranscriptionMode>(settings.transcriptionMode);
  const [referenceText, setReferenceText] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TranscriptRecord | null>(null);
  const [view, setView] = useState<"intended" | "verbatim">("intended");

  async function choose() {
    const selected = await bridge.chooseAudioFile();
    if (selected) { setFile(selected); setResult(null); }
  }

  async function run() {
    if (!file) return;
    setRunning(true);
    try {
      const record = await bridge.runLab({ operation, path: file.path, referenceText, mode });
      setResult(record);
      setView(record.intendedText ? "intended" : "verbatim");
      onResult(record);
      onToast("Speech Lab result added to history");
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  }

  const needsReference = operation !== "transcribe";
  const visibleText = view === "intended" ? result?.intendedText || result?.text : result?.verbatimText || result?.text;

  return (
    <div className="content-stack lab-page">
      <section className="view-toolbar"><div><strong>File operation</strong><span>The original media stays in place; processing and temporary conversion remain local.</span></div></section>

      <div className="lab-layout">
        <section className="lab-controls">
          <div className="operation-grid">
            {operations.map(({ id, icon: Icon, title, description }) => <button key={id} className={operation === id ? "active" : ""} onClick={() => { setOperation(id); setResult(null); }}><Icon /><span><strong>{title}</strong><small>{description}</small></span>{operation === id && <Check />}</button>)}
          </div>

          <button className={`file-drop ${file ? "has-file" : ""}`} onClick={() => void choose()}>
            <span><FileAudio /></span>
            <div>{file ? <><strong>{file.name}</strong><small>{(file.size / 1024 / 1024).toFixed(1)} MB · click to replace</small></> : <><strong>Choose audio or video</strong><small>WAV, MP3, M4A, FLAC, WebM, MP4, MOV, or MKV</small></>}</div>
            <Upload />
          </button>

          {operation === "transcribe" ? <div className="lab-field"><label>Transcript output</label><div className="segmented triple"><button className={mode === "intended" ? "active" : ""} onClick={() => setMode("intended")}>Intended</button><button className={mode === "verbatim" ? "active" : ""} onClick={() => setMode("verbatim")}>Verbatim</button><button className={mode === "dual" ? "active" : ""} onClick={() => setMode("dual")}>Both</button></div></div> : <div className="lab-field"><label>{operation === "verbatimize" ? "Trusted clean transcript" : "Exact transcript to align"}</label><textarea value={referenceText} onChange={(event) => setReferenceText(event.target.value)} placeholder={operation === "verbatimize" ? "Paste the clean transcript. CrisperWhisper will add only details that are audible…" : "Paste the exact words that should receive timestamps…"} /></div>}

          <button className="primary-button lab-run" disabled={!file || running || (needsReference && !referenceText.trim())} onClick={() => void run()}>{running ? <LoaderCircle className="spin" /> : <Sparkles />} {running ? "Working locally…" : operations.find((item) => item.id === operation)?.title}</button>
        </section>

        <section className="lab-result">
          {!result ? <div className="lab-empty"><Fingerprint /><h3>Millisecond truth lives here.</h3><p>Select a tool and an audio file. The original media remains where it is; Delulu only reads it for local inference.</p></div> : <>
            <div className="result-heading"><div><p className="eyebrow">RESULT · {result.mode}</p><h3>{result.sourceName}</h3></div><button className="icon-button" onClick={() => void bridge.copyText(visibleText ?? "").then(() => onToast("Copied to clipboard"))}><Copy /></button></div>
            {result.intendedText && result.verbatimText && <div className="segmented result-tabs"><button className={view === "intended" ? "active" : ""} onClick={() => setView("intended")}>Intended</button><button className={view === "verbatim" ? "active" : ""} onClick={() => setView("verbatim")}>Verbatim</button></div>}
            <div className="result-copy">{visibleText}</div>
            <div className="insight-strip"><span><Clock3 />{(result.durationMs / 1000).toFixed(1)}s audio</span><span><Fingerprint />{result.insights.fillerCount} fillers</span><span><ScanText />{result.words.length || result.verbatimWords.length} timed words</span></div>
            {(view === "verbatim" ? result.verbatimWords : result.words).length > 0 && <div className="word-timeline">{(view === "verbatim" ? result.verbatimWords : result.words).slice(0, 80).map((word, index) => <span key={`${word.start}-${index}`} title={`${word.start.toFixed(2)}–${word.end.toFixed(2)}s`}><b>{word.word}</b><small>{word.start.toFixed(2)}</small></span>)}</div>}
          </>}
        </section>
      </div>
    </div>
  );
}
