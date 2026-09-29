import {
  TranscriptCard,
  type TranscriptActions,
} from "../components/TranscriptCard";
import { useState } from "react";
import {
  FileAudio,
  LoaderCircle,
  ScanText,
  Sparkles,
  Upload,
} from "lucide-react";
import { Alert } from "../components/ui";
import { bridge } from "../bridge";
import type {
  AppSettings,
  AudioFileSelection,
  AudioFileMetadata,
  TranscriptRecord,
} from "../types";

export function LabPage({
  settings,
  busy,
  onResult,
  onToast,
  history,
  ...actions
}: TranscriptActions & {
  history: TranscriptRecord[];
  settings: AppSettings;
  busy: boolean;
  onResult: (record: TranscriptRecord) => void;
  onToast: (message: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<AudioFileSelection | null>(null);
  const [running, setRunning] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [metadata, setMetadata] = useState<AudioFileMetadata | null>(null);
  const [resultId, setResultId] = useState<string | null>(null);
  const result = history.find((record) => record.id === resultId);

  async function choose() {
    if (running || inspecting) return;
    setInspecting(true);
    try {
      const selected = await bridge.chooseAudioFile();
      if (selected) {
        setFile(selected);
        setResultId(null);
        setError(null);
        setMetadata(null);
        setMetadata(await bridge.inspectAudioFile(selected.path));
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setInspecting(false);
    }
  }

  async function run() {
    if (!file || busy || running || inspecting) return;
    setError(null);
    setRunning(true);
    try {
      const record = await bridge.runLab({ path: file.path });
      setResultId(record.id);
      onResult(record);
      onToast(
        settings.keepHistory
          ? "Transcript saved to history"
          : "Transcript ready for this session",
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="content-stack">
      {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
      <section className="view-toolbar">
        <div>
          <strong>File transcription</strong>
          <span>
            The original media stays in place; processing and temporary
            conversion remain local.
          </span>
        </div>
      </section>

      <div className="grid grid-cols-[330px_minmax(0,1fr)] gap-4 max-[1150px]:grid-cols-[260px_minmax(0,1fr)] max-[700px]:grid-cols-1">
        <section className="border border-line bg-surface rounded-panel shadow-panel backdrop-blur-xl overflow-hidden min-w-0 p-5 flex flex-col gap-4">
          <button
            disabled={running || inspecting}
            className="file-drop w-full flex items-center gap-2.5 px-3.5 py-5 bg-surface border border-dashed border-line-strong rounded-xl backdrop-blur-md text-left"
            onClick={() => void choose()}
          >
            <span>
              <FileAudio />
            </span>
            <div className="min-w-0 flex-1">
              {file ? (
                <>
                  <strong className="block text-[12px] break-words">
                    {file.name}
                  </strong>
                  <small className="block text-[10px] mt-1">
                    {(file.size / 1024 / 1024).toFixed(1)} MB · click to replace
                  </small>
                </>
              ) : (
                <>
                  <strong className="block text-[12px] break-words">
                    Choose audio or video
                  </strong>
                  <small className="block text-[10px] mt-1">
                    WAV, MP3, M4A, FLAC, WebM, MP4, MOV, or MKV
                  </small>
                </>
              )}
            </div>
            <Upload className="w-[15px] h-[15px] text-muted" />
          </button>

          {file && (
            <div className="text-[12px] flex flex-col gap-2" aria-live="polite">
              {inspecting ? (
                <p className="text-muted">Reading media metadata…</p>
              ) : metadata ? (
                <>
                  <dl className="grid grid-cols-2 gap-2">
                    <dt className="text-muted">Duration</dt>
                    <dd>{metadata.durationSeconds === null
                      ? "Unknown"
                      : `${Math.floor(metadata.durationSeconds / 60)}m ${Math.floor(metadata.durationSeconds % 60)}s`}</dd>
                    <dt className="text-muted">Channels</dt>
                    <dd>{metadata.channels ?? "Unknown"}</dd>
                    <dt className="text-muted">Sample rate</dt>
                    <dd>{metadata.sampleRate === null ? "Unknown" : `${metadata.sampleRate.toLocaleString()} Hz`}</dd>
                    <dt className="text-muted">Decoder</dt>
                    <dd>{metadata.decoder} · {metadata.decoderReady ? "available" : "not ready"}</dd>
                    <dt className="text-muted">Decoded audio estimate</dt>
                    <dd>{metadata.estimatedPcmBytes === null
                      ? "Unknown"
                      : `${(metadata.estimatedPcmBytes / 1024 / 1024).toFixed(1)} MiB`}</dd>
                  </dl>
                  <p className="text-muted">{metadata.decoderDetail}</p>
                  <p className="text-muted">Processing time: {metadata.processingTimeEstimate}</p>
                  <p className="text-muted">Audio estimate assumes mono 16 kHz, 16-bit PCM. Model memory is additional. Local processing has no API fee.</p>
                  {metadata.durationSeconds !== null && metadata.durationSeconds >= 300 && (
                    <p className="text-muted">Long recording: the current worker request has a maximum 15-minute time budget. Completion depends on hardware and model speed.</p>
                  )}
                </>
              ) : (
                <p className="text-muted">Media metadata unavailable. Duration, channels, processing cost and decoder readiness are unknown.</p>
              )}
            </div>
          )}

          <button
            className="primary-button lab-run"
            disabled={!file || busy || running || inspecting || metadata?.decoderReady === false}
            onClick={() => void run()}
          >
            {running ? <LoaderCircle className="spin" /> : <Sparkles />}{" "}
            {running ? "Working locally…" : "Transcribe"}
          </button>
        </section>

        <section className="lab-result border border-line bg-surface rounded-panel shadow-panel backdrop-blur-xl overflow-hidden min-w-0 px-[18px] py-4">
          {!result ? (
            <div className="min-h-[380px] flex flex-col items-center justify-center text-center">
              <ScanText className="w-[38px] h-[38px] text-accent [stroke-width:1] mb-[22px]" />
              <h3>No file processed</h3>
              <p className="max-w-[290px] text-[12px] text-muted mt-3">
                Choose a recording to transcribe. Everything is processed
                locally.
              </p>
            </div>
          ) : (
            <TranscriptCard
              key={result.id}
              record={result}
              inspector
              {...actions}
            />
          )}
        </section>
      </div>
    </div>
  );
}
