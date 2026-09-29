import { useRef, useState } from "react";
import { bridge } from "../bridge";
import { deliveredText, transcriptText } from "../transcriptText";
import type { AudioFileSelection, MagicRewriteRequest, Page, TranscriptRecord } from "../types";

export type ImportOperation = {
  file: AudioFileSelection | null;
  phase: "idle" | "choosing" | "selected" | "running" | "ready" | "error";
  resultId: string | null;
  error: string | null;
};
export type RewriteOperation = {
  key: number;
  transcriptId: string;
  label: string;
  source: string;
  baseline: string;
  origin: Page;
  visible: boolean;
  phase: "draft" | "working" | "ready" | "error";
};

/** Owned by useWorkspace, outside every page and transcript card lifetime. */
export function useWorkspaceOperations(receiveTranscript: (record: TranscriptRecord) => void) {
  const [importOperation, setImportOperation] = useState<ImportOperation>({ file: null, phase: "idle", resultId: null, error: null });
  const importRef = useRef(importOperation);
  const [rewriteOperation, setRewriteOperation] = useState<RewriteOperation | null>(null);
  const rewriteRef = useRef(rewriteOperation);
  const nextKey = useRef(0);
  const inFlight = useRef<{ kind: "import" | "rewrite"; key: number } | null>(null);
  const writeImport = (next: ImportOperation) => { importRef.current = next; setImportOperation(next); };
  const writeRewrite = (next: RewriteOperation | null) => { rewriteRef.current = next; setRewriteOperation(next); };

  const chooseImport = async () => {
    if (["choosing", "running"].includes(importRef.current.phase)) return;
    const previous = importRef.current;
    writeImport({ ...previous, phase: "choosing", error: null });
    try {
      const selected = await bridge.chooseAudioFile();
      writeImport(selected ? { file: selected, phase: "selected", resultId: null, error: null } : previous);
    } catch (error) {
      writeImport({ ...previous, phase: "error", error: error instanceof Error ? error.message : String(error) });
    }
  };
  const runImport = async (blocked: boolean) => {
    const current = importRef.current;
    if (!current.file || blocked || inFlight.current || ["choosing", "running"].includes(current.phase)) return;
    const lease = { kind: "import" as const, key: ++nextKey.current };
    inFlight.current = lease;
    writeImport({ ...current, phase: "running", error: null });
    try {
      const record = await bridge.runLab({ path: current.file.path });
      // Nothing can replace this import while running; navigation never cancels it.
      if (inFlight.current !== lease) return;
      receiveTranscript(record);
      writeImport({ ...current, phase: "ready", resultId: record.id, error: null });
    } catch (error) {
      if (inFlight.current === lease)
        writeImport({ ...current, phase: "error", error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (inFlight.current === lease) inFlight.current = null;
    }
  };
  const clearImportError = () => writeImport({ ...importRef.current, error: null });
  const openRewrite = (record: TranscriptRecord, origin: Page) => {
    // A second card resumes the existing draft instead of replacing its source/result.
    const current = rewriteRef.current;
    if (current) { writeRewrite({ ...current, visible: true }); return; }
    writeRewrite({ key: ++nextKey.current, transcriptId: record.id, label: `${record.sourceName ?? "Dictation"} · ${new Date(record.createdAt).toLocaleString()}`, source: transcriptText(record), baseline: deliveredText(record), origin, visible: true, phase: "draft" });
  };
  const showRewrite = () => {
    if (rewriteRef.current) writeRewrite({ ...rewriteRef.current, visible: true });
  };
  const hideRewrite = () => {
    if (rewriteRef.current?.visible) writeRewrite({ ...rewriteRef.current, visible: false });
  };
  const closeRewrite = (key: number) => {
    if (rewriteRef.current?.key !== key || (inFlight.current?.kind === "rewrite" && inFlight.current.key === key)) return;
    writeRewrite(null);
  };
  const rewriteState = (key: number, phase: RewriteOperation["phase"]) => {
    const current = rewriteRef.current;
    if (current?.key === key && current.phase !== phase) writeRewrite({ ...current, phase });
  };
  const runRewrite = async (key: number, request: MagicRewriteRequest) => {
    if (rewriteRef.current?.key !== key) throw new Error("This rewrite session is no longer available.");
    if (inFlight.current) throw new Error("Finish the active import or rewrite first.");
    const lease = { kind: "rewrite" as const, key };
    inFlight.current = lease;
    rewriteState(key, "working");
    try { return await bridge.rewriteMagic(request); }
    finally { if (inFlight.current === lease) inFlight.current = null; }
  };
  const applyRewrite = async (key: number, apply: () => Promise<boolean>) => {
    if (rewriteRef.current?.key !== key || inFlight.current) return false;
    const lease = { kind: "rewrite" as const, key };
    inFlight.current = lease;
    try { return await apply(); }
    finally { if (inFlight.current === lease) inFlight.current = null; }
  };
  return { importOperation, rewriteOperation, chooseImport, runImport, clearImportError, openRewrite, showRewrite, hideRewrite, closeRewrite, rewriteState, runRewrite, applyRewrite };
}
