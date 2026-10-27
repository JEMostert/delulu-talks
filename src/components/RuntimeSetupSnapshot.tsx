import { useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
import { SetupSpace } from "./SetupSpace";
import type { MagicModelId, RuntimeSetupSnapshot as Snapshot } from "../types";

/** Read-only interpreter and module discovery: no downloads, imports or model loading. */
export function RuntimeSetupSnapshot({
  pythonCommand,
  magicModel,
  busy,
}: {
  pythonCommand: string;
  magicModel: MagicModelId;
  busy: boolean;
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
    bridge
      .getRuntimeSetupSnapshot()
      .then((value) => {
        if (request.current === generation) setData(value);
      })
      .catch((reason) => {
        if (request.current === generation) {
          setData(null);
          setError(
            reason instanceof Error
              ? reason.message
              : "Snapshot unavailable. Retry or check Settings → Advanced.",
          );
        }
      })
      .finally(() => {
        if (request.current === generation) setLoading(false);
      });
    return () => {
      request.current += 1;
    };
  }, [pythonCommand, magicModel, refresh]);

  return (
    <section className="card" aria-label="Runtime snapshot" aria-busy={loading}>
      <div className="section-heading">
        <p className="text-xs text-muted" role="status">
          {loading
            ? "Checking interpreters…"
            : data
              ? `${data.platform} / ${data.arch} · checked ${new Date(data.checkedAt).toLocaleString()}`
              : ""}
        </p>
        <button
          className="secondary-button"
          disabled={loading || busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh
        </button>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {data && !loading && (
        <>
          {data.source === "preview" && (
            <p className="mt-3">Available in the desktop app.</p>
          )}
          {data.space && <SetupSpace space={data.space} />}
          {data.runtimes.map((runtime) => (
            <article
              key={runtime.kind}
              className="mt-4 rounded-panel border border-line p-4 [overflow-wrap:anywhere]"
            >
              <h4>{runtime.kind === "speech" ? "Speech" : "Rewriting"}</h4>
              <dl className="mt-3 grid grid-cols-[minmax(100px,160px)_1fr] gap-x-3 gap-y-2 text-sm max-[700px]:grid-cols-1">
                <dt>Runtime files</dt>
                <dd>
                  {runtime.runtimeState} · {runtime.directory ?? runtime.root}
                </dd>
                <dt>Expected revision</dt>
                <dd>{runtime.expectedRevision}</dd>
                <dt>Intended backend/device</dt>
                <dd>
                  {runtime.backend} · {runtime.devicePreference}
                  <p className="text-xs text-muted">
                    {runtime.deviceObservation}
                  </p>
                </dd>
                <dt>Active interpreter</dt>
                <dd>
                  {runtime.interpreter.executable ?? "Not observed"} ·{" "}
                  {runtime.interpreter.status}
                  {runtime.interpreter.version &&
                    ` · Python ${runtime.interpreter.version} / ${runtime.interpreter.machine}`}
                  <p className="text-xs text-muted">
                    {runtime.interpreter.detail}
                  </p>
                </dd>
                <dt>Module discovery</dt>
                <dd>
                  {runtime.interpreter.modules.length
                    ? runtime.interpreter.modules.map((module) => (
                        <p key={module.name}>
                          {module.name}: {module.status}
                          {module.status === "missing" &&
                            " · Repair installs it"}
                          {module.location && (
                            <span className="block text-xs text-muted">
                              {module.location}
                            </span>
                          )}
                        </p>
                      ))
                    : "Not observed. Install the dedicated runtime to inspect its modules."}
                </dd>
                <dt>Import probe</dt>
                <dd>{runtime.importProbe}</dd>
                <dt>Saved installer record</dt>
                <dd>
                  {runtime.cachedInventory.status}
                  {runtime.cachedInventory.revision &&
                    ` · revision ${runtime.cachedInventory.revision}`}
                  {runtime.cachedInventory.interpreter &&
                    ` · Python ${runtime.cachedInventory.interpreter}`}
                  {runtime.cachedInventory.createdAt && (
                    <p className="text-xs">
                      Recorded {runtime.cachedInventory.createdAt}
                    </p>
                  )}
                  <p className="text-xs text-muted">
                    {runtime.cachedInventory.detail}
                  </p>
                </dd>
              </dl>
              <details className="mt-3">
                <summary>Setup interpreter candidates</summary>
                <p className="mt-2 text-xs text-muted">
                  Configured: {pythonCommand}. Setup tries supported candidates
                  in this order. Probe observations do not guarantee a future
                  setup succeeds.
                </p>
                {runtime.bootstrap.length ? (
                  runtime.bootstrap.map((interpreter, index) => (
                    <p
                      className="mt-2 text-sm"
                      key={`${index}-${interpreter.command}`}
                    >
                      {interpreter.command}: {interpreter.status}
                      {interpreter.version &&
                        ` · Python ${interpreter.version} / ${interpreter.machine}`}
                      <span className="block text-xs text-muted">
                        {interpreter.executable ?? interpreter.detail}
                      </span>
                    </p>
                  ))
                ) : (
                  <p className="field-error">
                    Use an interpreter executable path in Settings → Advanced.
                    Arbitrary command arguments are not executed by this
                    snapshot.
                  </p>
                )}
                {runtime.bootstrap.find(
                  (interpreter) => interpreter.status === "observed",
                ) && (
                  <p className="mt-2 text-xs text-muted">
                    First compatible candidate observed:{" "}
                    {
                      runtime.bootstrap.find(
                        (interpreter) => interpreter.status === "observed",
                      )?.command
                    }
                    . Setup will perform its own validation.
                  </p>
                )}
                {!runtime.bootstrap.some(
                  (interpreter) => interpreter.status === "observed",
                ) && (
                  <p className="field-error">
                    No compatible setup interpreter observed. Configure a
                    supported Python in Settings → Advanced.
                  </p>
                )}
              </details>
            </article>
          ))}
        </>
      )}
    </section>
  );
}
