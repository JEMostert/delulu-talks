import { useEffect, useRef, useState } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
import { bridge } from "../bridge";
import { diagnosticReport } from "../diagnosticReport";
import { readStartupService } from "../startupServices";
import type { RuntimeDiagnostics } from "../types";
import { Alert } from "./ui";

/** Memory, Python, FFmpeg and permissions, with a privacy-safe copyable report. */
export function Diagnostics() {
  const [data, setData] = useState<RuntimeDiagnostics | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const mounted = useRef(false);
  const pending = useRef<AbortController | null>(null);
  async function refresh() {
    if (!mounted.current || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    try {
      const next = await readStartupService(
        "diagnostics",
        () => bridge.getDiagnostics(),
        controller.signal,
      );
      if (mounted.current && !controller.signal.aborted) {
        setData(next);
        setCopied(false);
      }
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted)
        setError(
          String(reason).replace(
            "Retry opening the workspace.",
            "Retry diagnostics.",
          ),
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      pending.current?.abort();
      pending.current = null;
    };
  }, []);
  return (
    <section className="card">
      <div className="section-heading">
        <h3>Health check</h3>
        <button
          className="tool-button"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw className={busy ? "spin" : ""} />
          {busy ? "Checking…" : error ? "Retry" : "Refresh"}
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
      {data && (
        <>
          <dl className="health-list">
            <div>
              <dt>Memory</dt>
              <dd>
                {data.memoryGB} GB total · {data.freeMemoryGB} GB free
              </dd>
            </div>
            <div>
              <dt>Python</dt>
              <dd>{data.python}</dd>
            </div>
            <div>
              <dt>FFmpeg</dt>
              <dd>
                {data.ffmpeg === "Not available"
                  ? "Not installed · Bottles needs it"
                  : "Installed"}
              </dd>
            </div>
            {(
              [
                ["Microphone", data.microphone],
                ["Accessibility", data.accessibility],
              ] as const
            ).map(
              ([label, permission]) =>
                permission &&
                permission.state !== "not-applicable" && (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>
                      {permission.state.replace(/-/g, " ")}
                      {permission.state !== "granted" && (
                        <small>{permission.detail}</small>
                      )}
                    </dd>
                  </div>
                ),
            )}
          </dl>
          {data.platform === "darwin" && data.arch === "arm64" && (
            <p className="caption">
              Large on Apple Silicon needs native arm64 Python 3.12.
            </p>
          )}
          <details>
            <summary>Technical details</summary>
            <dl>
              <dt>System</dt>
              <dd>
                {data.platform} · {data.arch}
              </dd>
              <dt>Local data</dt>
              <dd>{data.dataDirectory}</dd>
              <dt>Runtime</dt>
              <dd>{data.runtimeInstalled ? "Installed" : "Not installed"}</dd>
              {["mlx", "mlx-audio", "torch", "transformers"].map((name) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{data.packages[name] ?? "Not installed"}</dd>
                </div>
              ))}
            </dl>
            <p className="caption">
              The copied report leaves out local paths and transcripts.
            </p>
            <button
              className="secondary-button"
              onClick={async () => {
                try {
                  await bridge.copyText(
                    JSON.stringify(diagnosticReport(data), null, 2),
                  );
                  if (mounted.current) setCopied(true);
                } catch (reason) {
                  if (mounted.current) setError(String(reason));
                }
              }}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? "Diagnostics copied" : "Copy diagnostics"}
            </button>
          </details>
        </>
      )}
    </section>
  );
}
