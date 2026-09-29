import { useLayoutEffect, useRef, useState } from "react";
import { Copy, Download, Redo2, Undo2 } from "lucide-react";
import { bridge } from "../bridge";
import { TechnicalBuffer, type TechnicalEditTarget } from "../technicalBuffer";
import { correctionWordRange, previousIdentifierRange } from "../technicalEditingCommands";
import type { AppSettings, TranscriptRecord } from "../types";
import { Alert, ConfirmDialog, Modal } from "../components/ui";

export function TechnicalPage({ history, settings, busy, onUpdateSettings }: {
  history: TranscriptRecord[];
  settings: AppSettings;
  busy: boolean;
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<boolean>;
}) {
  const [buffer] = useState(() => new TechnicalBuffer());
  const [snapshot, setSnapshot] = useState(() => buffer.snapshot);
  const [sourceId, setSourceId] = useState("");
  const [pending, setPending] = useState<{
    target: TechnicalEditTarget;
    text: string;
    label: string;
  } | null>(null);
  const [replacement, setReplacement] = useState<{
    kind: "identifier" | "word";
    target: TechnicalEditTarget;
    original: string;
    text: string;
  } | null>(null);
  const [replacementError, setReplacementError] = useState("");
  const [switchingMode, setSwitchingMode] = useState(false);
  const switchingModeRef = useRef(false);
  const [clear, setClear] = useState(false);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [composition, setComposition] = useState<string | null>(null);
  const composing = useRef(false);
  const copyingRef = useRef(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const focusEditor = useRef(false);
  const source = history.find((record) => record.id === sourceId) ?? history[0];

  function publish(focus = false) {
    focusEditor.current = focus;
    setSnapshot({ ...buffer.snapshot });
    setMessage("");
  }
  function captureSelection() {
    if (composing.current) return;
    const input = editor.current;
    if (input) {
      const before = buffer.snapshot;
      buffer.select(input.selectionStart, input.selectionEnd);
      const after = buffer.snapshot;
      if (before.selectionStart !== after.selectionStart || before.selectionEnd !== after.selectionEnd)
        setSnapshot(after);
    }
  }
  function prepareInsertion() {
    if (!source || composing.current) return;
    captureSelection();
    setPending({
      target: buffer.captureTarget(),
      text: source.text,
      label: `${new Date(source.createdAt).toLocaleString()} · ${source.sourceName ?? "Dictation"}`,
    });
    setError("");
  }
  function applyInsertion() {
    if (!pending || composing.current) return;
    captureSelection();
    try {
      buffer.applyInsert(pending.target, pending.text);
      setPending(null);
      setError("");
      publish(true);
    } catch (reason) {
      setError(String(reason));
    }
  }
  function insert(text: string) {
    captureSelection();
    buffer.insert(text);
    publish(true);
  }
  function replaceToken(kind: "identifier" | "word") {
    if (composing.current) return;
    captureSelection();
    const current = buffer.snapshot;
    const displayed = buffer.displayText;
    const range = kind === "identifier"
      ? previousIdentifierRange(displayed, current.selectionStart)
      : correctionWordRange(displayed, current.selectionStart, current.selectionEnd);
    if (!range) { setError(`No ${kind} found at this caret or selection.`); return; }
    buffer.select(range.start, range.end);
    editor.current?.setSelectionRange(range.start, range.end);
    const original = displayed.slice(range.start, range.end);
    setReplacement({ kind, target: buffer.captureTarget(), original, text: original });
    setReplacementError("");
    publish();
  }
  function applyReplacement() {
    if (!replacement || composing.current) return;
    if (replacement.kind === "identifier" &&
        !/^[\p{L}_$][\p{L}\p{M}\p{N}_$]*(?:-[\p{L}\p{N}_$][\p{L}\p{M}\p{N}_$]*)*$/u.test(replacement.text)) {
      setReplacementError("Enter one identifier, without spaces or punctuation.");
      return;
    }
    try {
      buffer.applyInsert(replacement.target, replacement.text);
      setReplacement(null);
      setError("");
      publish(true);
    } catch (reason) { setReplacementError(String(reason)); }
  }
  function insertNewline() {
    insert(buffer.snapshot.text.match(/\r\n|\r|\n/)?.[0] ?? "\n");
  }
  async function returnToProse() {
    if (busy || switchingModeRef.current || composing.current) return;
    switchingModeRef.current = true;
    setSwitchingMode(true);
    try {
      if (await onUpdateSettings({ dictationMode: "prose" }))
        setMessage("Prose dictation mode active. Technical draft preserved.");
      else setError("Could not switch dictation mode. Try again when idle.");
    } catch (reason) { setError(String(reason)); }
    finally { switchingModeRef.current = false; setSwitchingMode(false); }
  }
  useLayoutEffect(() => {
    if (!focusEditor.current) return;
    focusEditor.current = false;
    editor.current?.focus();
    editor.current?.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
  }, [snapshot]);

  async function copy() {
    if (copyingRef.current) return;
    copyingRef.current = true;
    setCopying(true);
    setError("");
    const text = buffer.snapshot.text;
    try {
      await bridge.copyText(text);
      setMessage("Copied the buffer snapshot to the clipboard.");
    } catch (reason) {
      setError(String(reason));
    } finally {
      copyingRef.current = false;
      setCopying(false);
    }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([buffer.snapshot.text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "technical-draft.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage("Requested a text download of the buffer snapshot.");
  }

  return (
    <div className="content-stack">
      <section className="card">
        <div className="section-heading"><h2>Technical text buffer</h2></div>
        <p className="mt-3 text-sm text-muted">
          Edit literal text with its indentation, punctuation and Unicode intact. Inserting a
          transcript uses its recognition original, leaving the transcript unchanged. Text is
          never executed or automatically pasted.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="field min-w-0 flex-1">
            Recognition original to insert
            <select value={source?.id ?? ""} disabled={!history.length || composing.current}
              onChange={(event) => setSourceId(event.target.value)}>
              {!history.length && <option value="">No transcripts available</option>}
              {history.map((record) => <option key={record.id} value={record.id}>
                {new Date(record.createdAt).toLocaleString()} · {record.sourceName ?? "Dictation"}
              </option>)}
            </select>
          </label>
          <button className="secondary-button" disabled={!source?.text || composing.current}
            onClick={prepareInsertion}>Prepare insertion preview</button>
        </div>
        {source && <details className="mt-3"><summary>Preview recognition original</summary>
          <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{source.text}</pre>
        </details>}
        {pending && (
          <section className="mt-4 rounded-lg border border-line p-4" aria-label="Pending technical insertion">
            <h3>Prepared insertion</h3>
            <p className="mt-2 text-xs text-muted">{pending.label}</p>
            <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{pending.text}</pre>
            <p className="mt-3 text-sm">
              {pending.target.start === pending.target.end ? "Insert at the captured caret." : "Replace the captured selection."}
              {" "}Editing the draft or moving its selection requires a fresh preview.
            </p>
            {!buffer.isTargetCurrent(pending.target) && (
              <p className="mt-3 text-sm" role="status">The buffer or selection changed. Prepare a new insertion preview; this one cannot be applied.</p>
            )}
            <div className="runtime-actions mt-3">
              <button className="primary-button" disabled={composing.current || !buffer.isTargetCurrent(pending.target)}
                onClick={applyInsertion}>Apply insertion</button>
              <button className="secondary-button" onClick={() => setPending(null)}>Cancel preview</button>
            </div>
          </section>
        )}
        <div className="runtime-actions mt-4">
          <button className="tool-button" disabled={!buffer.canUndo || composing.current}
            onClick={() => { buffer.undo(); publish(true); }}><Undo2 /> Undo</button>
          <button className="tool-button" disabled={!buffer.canRedo || composing.current}
            onClick={() => { buffer.redo(); publish(true); }}><Redo2 /> Redo</button>
          <button className="tool-button" disabled={composing.current} onClick={() => insert("\t")}>Insert tab</button>
          <button className="tool-button" disabled={!snapshot.text || composing.current} onClick={() => setClear(true)}>Clear draft…</button>
        </div>
        <div className="runtime-actions mt-3">
          <button className="tool-button" disabled={composing.current} aria-keyshortcuts="Control+Alt+I Meta+Alt+I"
            onClick={() => replaceToken("identifier")}>Replace last identifier</button>
          <button className="tool-button" disabled={composing.current} aria-keyshortcuts="Control+Alt+W Meta+Alt+W"
            onClick={() => replaceToken("word")}>Correct word</button>
          <button className="tool-button" disabled={composing.current} aria-keyshortcuts="Control+Alt+Enter Meta+Alt+Enter"
            onClick={insertNewline}>Insert newline</button>
          <button className="tool-button" disabled={busy || switchingMode || composing.current}
            aria-keyshortcuts="Control+Alt+P Meta+Alt+P" onClick={() => void returnToProse()}>
            {switchingMode ? "Switching…" : "Return to prose"}
          </button>
        </div>
        <p className="mt-2 text-xs text-muted">Dictation mode: {settings.dictationMode ?? "prose"}. In the editor, use Ctrl/⌘+Alt+I
          for the last identifier, +W for a word, +Enter for a newline, +P for prose.
          Replacement previews require confirmation and remain undoable.</p>
        <label className="field mt-4">
          Literal technical draft
          <textarea ref={editor} rows={16} wrap="off" spellCheck={false} autoCapitalize="off" autoCorrect="off"
            className="w-full resize-y font-mono text-sm [tab-size:4]"
            value={composition ?? buffer.displayText}
            onSelect={captureSelection}
            onBeforeInput={captureSelection}
            onCompositionStart={() => { captureSelection(); composing.current = true; setComposition(buffer.displayText); }}
            onCompositionEnd={(event) => {
              composing.current = false;
              setComposition(null);
              buffer.edit(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd);
              publish();
            }}
            onChange={(event) => {
              if (composing.current) { setComposition(event.target.value); return; }
              buffer.edit(event.target.value, event.target.selectionStart, event.target.selectionEnd);
              publish();
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || composing.current) return;
              captureSelection();
              if ((event.ctrlKey || event.metaKey) && event.altKey && !event.shiftKey &&
                  !event.getModifierState("AltGraph")) {
                const key = event.key.toLowerCase();
                if (["i", "w", "enter", "p"].includes(key)) {
                  event.preventDefault();
                  if (event.repeat) return;
                  if (key === "i") replaceToken("identifier");
                  else if (key === "w") replaceToken("word");
                  else if (key === "enter") insertNewline();
                  else void returnToProse();
                  return;
                }
              }
              if ((event.ctrlKey || event.metaKey) && !event.altKey) {
                const key = event.key.toLowerCase();
                if (key === "z" || key === "y") {
                  event.preventDefault();
                  if (key === "y" || event.shiftKey) buffer.redo(); else buffer.undo();
                  publish(true);
                }
              }
            }} />
        </label>
        <p className="mt-3 text-xs text-muted">
          Undo/redo restores text and selection. History is bounded; your current draft is never
          truncated. The draft survives navigation during this app session and is not saved to
          disk automatically. Copy or download it before closing the app. Tab moves focus;
          Insert tab adds indentation at the selection.
        </p>
        <div className="runtime-actions mt-4">
          <button className="secondary-button" disabled={copying || !snapshot.text || composing.current}
            onClick={() => void copy()}><Copy /> {copying ? "Copying…" : "Copy draft"}</button>
          <button className="secondary-button" disabled={!snapshot.text || composing.current}
            onClick={download}><Download /> Download text</button>
        </div>
        {message && <p className="mt-3 text-sm" role="status">{message}</p>}
        {error && <Alert>{error}</Alert>}
      </section>
      {replacement && <Modal title={replacement.kind === "identifier" ? "Replace last identifier" : "Correct word"}
        onClose={() => setReplacement(null)} footer={<>
          <button className="secondary-button" onClick={() => setReplacement(null)}>Cancel</button>
          <button className="primary-button" disabled={!replacement.text.trim() || !buffer.isTargetCurrent(replacement.target)}
            onClick={applyReplacement}>Replace in draft</button>
        </>}>
        <p>Replace only this captured range. The original transcript is preserved.</p>
        <pre className="my-3 whitespace-pre-wrap font-mono">{replacement.original}</pre>
        <label className="field">Replacement
          <input autoFocus maxLength={1024} value={replacement.text}
            onChange={(event) => setReplacement({ ...replacement, text: event.target.value })} />
        </label>
        {!buffer.isTargetCurrent(replacement.target) && <p role="alert">The draft or selection changed. Cancel and prepare again.</p>}
        {replacementError && <p className="field-error" role="alert">{replacementError}</p>}
      </Modal>}
      {clear && <ConfirmDialog title="Clear the technical draft?" confirmLabel="Clear draft"
        onClose={() => setClear(false)} onConfirm={() => { buffer.clear(); publish(true); }}>
        <p>This clears only the buffer. Source transcripts remain unchanged. You can undo this during this session.</p>
      </ConfirmDialog>}
    </div>
  );
}
