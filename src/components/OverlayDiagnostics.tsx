import { useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
import type { OverlayDiagnostics as Snapshot } from "../types";

export function OverlayDiagnostics() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    bridge.getOverlayDiagnostics().then((value) => {
      if (mounted.current) setData(value);
    }).catch(() => {
      if (mounted.current) setError("Optional overlay diagnostics unavailable. Capture can continue through Controls.");
    });
    return () => { mounted.current = false; };
  }, []);
  async function check() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const value = await bridge.getOverlayDiagnostics(true);
      if (mounted.current) setData(value);
    } catch {
      if (mounted.current) setError("Dependency check failed. Check the desktop session and system Python; capture remains available through Controls.");
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className="mt-4 rounded-panel border border-line p-4 [overflow-wrap:anywhere]" aria-busy={busy}>
      <strong className="text-sm">Optional Linux recording overlay</strong>
      <p className="mt-2 text-xs text-muted">Explicit checking imports the system HUD dependencies and connects to the Wayland display to query layer-shell support. It shows no window, downloads nothing and does not acquire the microphone or load models.</p>
      <button className="secondary-button mt-3" disabled={busy || data?.status === "unsupported"} onClick={() => void check()}>{busy ? "Checking overlay dependencies…" : "Check overlay dependencies"}</button>
      {error && <p className="field-error" role="alert">{error}</p>}
      {data && (
        <div className="mt-3 text-xs" role="status">
          <p>Dependency check: {data.status.replaceAll("-", " ")}{data.checkedAt && ` · ${new Date(data.checkedAt).toLocaleString()}`}</p>
          <p className="mt-2 text-muted">{data.detail}</p>
          <p className="mt-2">Helper readiness reported: {data.helperReady ? "Yes" : "No"}. Dependencies and protocol support do not verify visible placement or click-through behavior.</p>
          {data.checks.map((item) => <p key={item.name} className="mt-2"><strong>{item.name}: {item.state}</strong><span className="block text-muted">{item.detail}</span></p>)}
          {data.interpreter && <p className="mt-2 text-muted">Overlay interpreter: {data.interpreter}</p>}
          {data.library && <p className="mt-2 text-muted">Library candidate: {data.library}</p>}
        </div>
      )}
      <p className="mt-3 text-xs text-muted">Missing PyCairo, PyGObject, GTK4 or Gtk4LayerShell bindings are system dependencies, separate from the speech runtime. Use Controls and its recording status when the overlay is unavailable; capture, transcription and saved results do not require it.</p>
    </div>
  );
}
