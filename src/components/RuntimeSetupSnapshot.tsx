import { useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
import { SetupSpace } from "./SetupSpace";
import type { MagicModelId, RuntimeSetupSnapshot as Snapshot } from "../types";

export function RuntimeSetupSnapshot({ pythonCommand, magicModel, busy, onPending }: {
  pythonCommand: string;
  magicModel: MagicModelId;
  busy: boolean;
  onPending: (pending: boolean) => void;
}) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const request = useRef(0);
  useEffect(() => {
    const generation = ++request.current;
    setLoading(true);
    setError(null);
    onPending(true);
    bridge.getRuntimeSetupSnapshot().then((value) => {
      if (request.current === generation) setData(value);
    }).catch((reason) => {
      if (request.current === generation) {
        setData(null);
        setError(reason instanceof Error ? reason.message : "Snapshot unavailable. Retry or check Settings → Advanced.");
      }
    }).finally(() => {
      if (request.current === generation) {
        setLoading(false);
        onPending(false);
      }
    });
    return () => { request.current += 1; };
  }, [pythonCommand, magicModel, refresh, onPending]);

  return (
    <section className="card" aria-labelledby="setup-snapshot-heading" aria-busy={loading}>
      <div className="section-heading">
        <div>
          <span className="eyebrow">BEFORE SETUP OR LOADING</span>
          <h3 id="setup-snapshot-heading">Runtime setup snapshot</h3>
        </div>
        <button className="secondary-button" disabled={loading || busy} onClick={() => setRefresh((value) => value + 1)}>Refresh snapshot</button>
      </div>
      <p className="mt-3 text-sm text-muted">Read-only interpreter and module discovery. No package downloads, runtime package imports or model loading.</p>
      {loading && <p className="mt-3" role="status">Checking interpreters and saved setup records…</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
      {data && !loading && (
        <>
          <p className="mt-3 text-xs text-muted">{data.platform} / {data.arch} · Observed {new Date(data.checkedAt).toLocaleString()}. Refresh after setup or changes.</p>
          {data.source === "preview" && <p className="mt-3">Desktop app required. Browser preview cannot observe interpreters, imports or devices.</p>}
          {data.space && <SetupSpace space={data.space} />}
          {data.runtimes.map((runtime) => (
            <article key={runtime.kind} className="mt-4 rounded-panel border border-line p-4 [overflow-wrap:anywhere]">
              <h4>{runtime.kind === "speech" ? "R2T2 speech" : "Optional Qwen 3.5 rewriting"}</h4>
              <dl className="mt-3 grid grid-cols-[minmax(100px,160px)_1fr] gap-x-3 gap-y-2 text-sm max-[700px]:grid-cols-1">
                <dt>Runtime files</dt><dd>{runtime.runtimeState} · {runtime.directory ?? runtime.root}</dd>
                <dt>Expected revision</dt><dd>{runtime.expectedRevision}</dd>
                <dt>Intended backend/device</dt><dd>{runtime.backend} · {runtime.devicePreference}<p className="text-xs text-muted">{runtime.deviceObservation}</p></dd>
                <dt>Active interpreter</dt><dd>{runtime.interpreter.executable ?? "Not observed"} · {runtime.interpreter.status}{runtime.interpreter.version && ` · Python ${runtime.interpreter.version} / ${runtime.interpreter.machine}`}<p className="text-xs text-muted">{runtime.interpreter.detail}</p></dd>
                <dt>Module discovery</dt><dd>{runtime.interpreter.modules.length ? runtime.interpreter.modules.map((module) => <p key={module.name}>{module.name}: {module.status}{module.status === "missing" && " — run Setup/Repair to install dependencies"}{module.location && <span className="block text-xs text-muted">{module.location}</span>}</p>) : "Not observed. Install the dedicated runtime to inspect its modules."}</dd>
                <dt>Import probe</dt><dd>{runtime.importProbe}</dd>
                <dt>Saved installer record</dt><dd>{runtime.cachedInventory.status}{runtime.cachedInventory.revision && ` · revision ${runtime.cachedInventory.revision}`}{runtime.cachedInventory.interpreter && ` · Python ${runtime.cachedInventory.interpreter}`}{runtime.cachedInventory.createdAt && <p className="text-xs">Recorded {runtime.cachedInventory.createdAt}</p>}<p className="text-xs text-muted">{runtime.cachedInventory.detail}</p></dd>
              </dl>
              <details className="mt-3">
                <summary>Setup interpreter candidates</summary>
                <p className="mt-2 text-xs text-muted">Configured: {pythonCommand}. Setup tries supported candidates in this order. Probe observations do not guarantee a future setup succeeds.</p>
                {runtime.bootstrap.length ? runtime.bootstrap.map((interpreter, index) => <p className="mt-2 text-sm" key={`${index}-${interpreter.command}`}>{interpreter.command}: {interpreter.status}{interpreter.version && ` · Python ${interpreter.version} / ${interpreter.machine}`}<span className="block text-xs text-muted">{interpreter.executable ?? interpreter.detail}</span></p>) : <p className="field-error">Use an interpreter executable path in Settings → Advanced. Arbitrary command arguments are not executed by this snapshot.</p>}
                {runtime.bootstrap.find((interpreter) => interpreter.status === "observed") && <p className="mt-2 text-xs text-muted">First compatible candidate observed: {runtime.bootstrap.find((interpreter) => interpreter.status === "observed")?.command}. Setup will perform its own validation.</p>}
                {!runtime.bootstrap.some((interpreter) => interpreter.status === "observed") && <p className="field-error">No compatible setup interpreter observed. Configure a supported Python in Settings → Advanced.</p>}
              </details>
            </article>
          ))}
        </>
      )}
    </section>
  );
}
