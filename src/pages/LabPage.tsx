import { TranscriptCard, type TranscriptActions } from "../components/TranscriptCard";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { FileAudio, LoaderCircle, ScanText, Sparkles, Upload } from "lucide-react";
import { Alert } from "../components/ui";
import { bridge } from "../bridge";
import { MAX_AUDIO_BATCH_FILES, SUPPORTED_AUDIO_EXTENSIONS } from "../audioFormats";
import type { AppSettings, AudioFileSelection, TranscriptRecord } from "../types";

type SelectedFile = AudioFileSelection & {
  state: "pending" | "running" | "done" | "failed";
  error?: string;
  resultId?: string;
  sourceAvailable?: boolean;
  sourceError?: string;
};

export function LabPage({ settings, busy, onResult, onToast, history, ...actions }: TranscriptActions & {
  history: TranscriptRecord[];
  settings: AppSettings;
  busy: boolean;
  onResult: (record: TranscriptRecord) => void;
  onToast: (message: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [running, setRunning] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [resultId, setResultId] = useState<string | null>(null);
  const stop = useRef(false);
  const active = useRef(false);
  const selectionActive = useRef(false);
  useEffect(() => {
    let alive = true;
    selectionActive.current = true;
    setSelecting(true);
    void bridge.getAudioJobs().then((jobs) => {
      if (alive) setFiles(jobs);
    }).catch((reason) => {
      if (alive) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (alive) { selectionActive.current = false; setSelecting(false); }
    });
    return () => { alive = false; stop.current = true; };
  }, []);
  const result = history.find((record) => record.id === resultId);
  const pending = files.filter((file) => file.state === "pending" && file.sourceAvailable !== false).length;

  function select(selected: AudioFileSelection[]) {
    if (!selected.length) return;
    // Resolve the complete batch before replacing the previous selection.
    const unique = [...new Map(selected.map((file) => [file.path, file])).values()];
    setFiles(unique.map((file) => ({ ...file, state: "pending" })));
    setResultId(null);
    setError(null);
  }

  async function choose(dropped?: File[]) {
    if (active.current || selectionActive.current) return;
    selectionActive.current = true;
    setSelecting(true);
    try {
      select(dropped ? await bridge.resolveAudioFiles(dropped) : await bridge.chooseAudioFiles());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      selectionActive.current = false;
      setSelecting(false);
    }
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (active.current || selectionActive.current) return;
    const dropped = Array.from(event.dataTransfer.files);
    if (!dropped.length) {
      setError("Drop local audio or video files; links and folders are not supported.");
      return;
    }
    void choose(dropped);
  }

  function update(path: string, change: Partial<SelectedFile>) {
    setFiles((items) => items.map((item) => item.path === path ? { ...item, ...change } : item));
  }

  async function remove(path: string) {
    if (active.current || selectionActive.current) return;
    try {
      await bridge.removeAudioJob(path);
      setFiles((items) => items.filter((item) => item.path !== path));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function relink(path: string) {
    if (active.current || selectionActive.current || busy) return;
    selectionActive.current = true;
    setSelecting(true);
    try {
      const job = await bridge.relinkAudioJob(path);
      if (job) setFiles((items) => items.map((item) => item.path === path ? job : item));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      selectionActive.current = false;
      setSelecting(false);
    }
  }

  async function run() {
    if (!pending || busy || active.current || selectionActive.current) return;
    active.current = true;
    stop.current = false;
    setError(null);
    setRunning(true);
    let completed = 0;
    try {
      for (const file of files.filter((item) => item.state === "pending" && item.sourceAvailable !== false)) {
        if (stop.current) break;
        update(file.path, { state: "running", error: undefined });
        try {
          const record = await bridge.runLab({ path: file.path });
          update(file.path, { state: "done", resultId: record.id });
          setResultId(record.id);
          onResult(record);
          completed += 1;
        } catch (reason) {
          update(file.path, { state: "failed", error: reason instanceof Error ? reason.message : String(reason) });
          try {
            const saved = (await bridge.getAudioJobs()).find((job) => job.path === file.path);
            if (saved?.sourceAvailable === false) update(file.path, { sourceAvailable: false, sourceError: saved.sourceError });
          } catch { /* Keep the original visible import failure. */ }
        }
      }
      if (completed) onToast(`${completed} transcript${completed === 1 ? "" : "s"} ${settings.keepHistory ? "saved to history" : "ready for this session"}`);
    } finally {
      active.current = false;
      setRunning(false);
    }
  }

  return (
    <div className="content-stack" onDragOver={(event) => event.preventDefault()} onDrop={drop}>
      {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
      <section className="view-toolbar">
        <div><strong>File transcription</strong><span>The original media stays in place; processing and temporary conversion remain local.</span></div>
      </section>
      <div className="grid grid-cols-[330px_minmax(0,1fr)] gap-4 max-[1150px]:grid-cols-[260px_minmax(0,1fr)] max-[700px]:grid-cols-1">
        <section className="border border-line bg-surface rounded-panel shadow-panel backdrop-blur-xl overflow-hidden min-w-0 p-5 flex flex-col gap-4">
          <button
            disabled={running || selecting}
            className={`file-drop w-full flex items-center gap-2.5 px-3.5 py-5 bg-surface border border-dashed ${dragging ? "border-accent" : "border-line-strong"} rounded-xl backdrop-blur-md text-left`}
            onClick={() => void choose()}
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = running || selecting ? "none" : "copy"; setDragging(true); }}
            onDragLeave={() => setDragging(false)}
          >
            <FileAudio />
            <div className="min-w-0 flex-1">
              <strong className="block text-[12px] break-words">{selecting ? "Checking files…" : "Choose or drop audio and video"}</strong>
              <small className="block text-[10px] mt-1">{SUPPORTED_AUDIO_EXTENSIONS.join(", ").toUpperCase()} · up to {MAX_AUDIO_BATCH_FILES} files</small>
            </div>
            <Upload className="w-[15px] h-[15px] text-muted" />
          </button>
          {files.length > 0 && (
            <ul className="flex flex-col gap-3 max-h-[340px] overflow-auto" aria-label="Selected files" aria-live="polite">
              {files.map((file) => (
                <li key={file.path} className="text-[12px] break-words">
                  <strong>{file.name}</strong>
                  <div className="text-[10px] text-muted">{(file.size / 1024 / 1024).toFixed(1)} MB · {file.state === "running" ? "Transcribing locally" : file.state === "done" ? "Complete" : file.state === "failed" ? "Failed" : "Ready"}</div>
                  {file.error && <p role="alert" className="text-[11px]">{file.error}</p>}
                  {file.sourceError && <p role="alert" className="text-[11px]">Source unavailable: {file.sourceError}. Relink explicitly to process this job.</p>}
                  <div className="flex flex-wrap gap-3 mt-1">
                    {file.resultId && <button className="text-accent" onClick={() => setResultId(file.resultId!)}>Show transcript</button>}
                    {file.state === "failed" && <button disabled={running || selecting || file.sourceAvailable === false} className="text-accent" onClick={() => update(file.path, { state: "pending", error: undefined })}>Retry</button>}
                    {(file.sourceAvailable === false || file.state === "failed") && <button disabled={running || selecting || busy} className="text-accent" onClick={() => void relink(file.path)}>Relink source</button>}
                    <button disabled={running || selecting} className="text-muted" onClick={() => void remove(file.path)}>Remove</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <button className="primary-button lab-run" disabled={!pending || busy || running || selecting} onClick={() => void run()}>
            {running ? <LoaderCircle className="spin" /> : <Sparkles />}{" "}{running ? "Working locally…" : `Transcribe${pending > 1 ? ` ${pending} files` : ""}`}
          </button>
          {running && <button className="text-[12px] text-muted" onClick={() => { stop.current = true; }}>Stop after current file</button>}
          {files.length > 1 && <p className="text-[10px] text-muted">Files are processed one at a time. Job metadata is saved locally; source audio stays in place. Replacing this list removes its previous job metadata.</p>}
        </section>
        <section className="lab-result border border-line bg-surface rounded-panel shadow-panel backdrop-blur-xl overflow-hidden min-w-0 px-[18px] py-4">
          {!result ? (
            <div className="min-h-[380px] flex flex-col items-center justify-center text-center">
              <ScanText className="w-[38px] h-[38px] text-accent [stroke-width:1] mb-[22px]" />
              <h3>No file processed</h3><p className="max-w-[290px] text-[12px] text-muted mt-3">Choose recordings to transcribe. Everything is processed locally.</p>
            </div>
          ) : <TranscriptCard key={result.id} record={result} inspector {...actions} />}
        </section>
      </div>
    </div>
  );
}
