import { useEffect, useState } from "react";
import { Check, Copy, HardDrive, RefreshCw, Terminal } from "lucide-react";
import { bridge } from "../bridge";
import type { RuntimeDiagnostics } from "../types";
import { Alert } from "./ui";

export function Diagnostics() {
  const [data, setData] = useState<RuntimeDiagnostics | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      setData(await bridge.getDiagnostics());
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <section className="card diagnostics">
      <div className="section-heading">
        <div>
          <span className="eyebrow">YOUR DEVICE</span>
          <h3>A quick health check</h3>
        </div>
        <button
          className="tool-button"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw className={busy ? "spin" : ""} />
          {busy ? "Checking…" : "Refresh"}
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
      {data && (
        <>
          <div className="diagnostic-grid">
            <div>
              <HardDrive />
              <span>
                Memory
                <strong>
                  {data.memoryGB} GB total · {data.freeMemoryGB} GB free
                </strong>
              </span>
            </div>
            <div>
              <Terminal />
              <span>
                Python<strong>{data.python}</strong>
              </span>
            </div>
            <div>
              <Check />
              <span>
                Media imports
                <strong>
                  {data.ffmpeg === "Not available"
                    ? "FFmpeg needs installing"
                    : "FFmpeg available"}
                </strong>
              </span>
            </div>
          </div>
          <p className="caption">
            {data.memoryGB < 16
              ? "Start with Small speech and 0.8B Magic. Keep one model loaded at a time if memory is tight."
              : "Medium speech is a good starting point. Larger models use more memory; try them after your first recording."}
          </p>
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
              {["crisperwhisper", "torch", "transformers"].map((name) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{data.packages[name] ?? "Not installed"}</dd>
                </div>
              ))}
            </dl>
            <button
              className="secondary-button"
              onClick={async () => {
                try {
                  await bridge.copyText(JSON.stringify(data, null, 2));
                  setCopied(true);
                } catch (reason) {
                  setError(String(reason));
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
