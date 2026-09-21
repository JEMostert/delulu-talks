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
    <section className="card">
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
          <div className="mt-[22px] mb-[18px] grid grid-cols-3 gap-[15px] max-[1150px]:grid-cols-1">
            <div className="flex gap-2.5 rounded-xl bg-soft p-[15px] text-muted">
              <HardDrive />
              <span className="text-[10px]">
                Memory
                <strong className="mt-[5px] block text-xs text-ink">
                  {data.memoryGB} GB total · {data.freeMemoryGB} GB free
                </strong>
              </span>
            </div>
            <div className="flex gap-2.5 rounded-xl bg-soft p-[15px] text-muted">
              <Terminal />
              <span className="text-[10px]">
                Python
                <strong className="mt-[5px] block text-xs text-ink">
                  {data.python}
                </strong>
              </span>
            </div>
            <div className="flex gap-2.5 rounded-xl bg-soft p-[15px] text-muted">
              <Check />
              <span className="text-[10px]">
                Media imports
                <strong className="mt-[5px] block text-xs text-ink">
                  {data.ffmpeg === "Not available"
                    ? "FFmpeg needs installing"
                    : "FFmpeg available"}
                </strong>
              </span>
            </div>
          </div>
          <p className="caption">
            {data.platform === "darwin" && data.arch === "arm64"
              ? "Qwen3-ASR runs locally through MLX on Apple Silicon. Language is detected automatically."
              : data.memoryGB < 16
                ? "Speech uses the CUDA GPU when present. Keep one model loaded at a time if memory is tight."
                : "R2T2 loads on your CUDA GPU. Magic rewrites are optional and use more memory while loaded."}
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
              {["qwen_asr", "torch", "transformers"].map((name) => (
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
