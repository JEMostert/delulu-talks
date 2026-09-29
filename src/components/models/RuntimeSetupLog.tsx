import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../../bridge";
import type { RuntimeSetupLog as SetupLogSnapshot } from "../../types";
import { Modal } from "../ui";

function formatLog(snapshot: SetupLogSnapshot) {
  const time = (value: number | null) =>
    value === null ? "None" : `${new Date(value).toISOString()} (${value})`;
  return [
    `${snapshot.kind === "speech" ? "Speech" : "Rewriting"} runtime setup log`,
    `Started: ${time(snapshot.startedAt)}`,
    `Finished: ${time(snapshot.finishedAt)}`,
    "Snapshot (command program and arguments are JSON strings):",
    JSON.stringify(snapshot, null, 2),
  ].join("\n");
}

function SetupLogDialog({
  kind,
  onClose,
}: {
  kind: "speech" | "rewrite";
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<SetupLogSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const token = ++request.current;
    setLoading(true);
    setError("");
    setCopied(false);
    try {
      const next = await bridge.getSetupLog(kind);
      if (request.current === token) setSnapshot(next);
    } catch (reason) {
      if (request.current === token) setError(`Could not load setup log: ${String(reason)}`);
    } finally {
      if (request.current === token) setLoading(false);
    }
  }, [kind]);
  useEffect(() => {
    void refresh();
    return () => {
      ++request.current;
    };
  }, [refresh]);
  async function copy() {
    if (!snapshot) return;
    const token = request.current;
    setCopying(true);
    setCopied(false);
    setError("");
    try {
      await bridge.copyText(formatLog(snapshot));
      if (request.current === token) setCopied(true);
    } catch (reason) {
      if (request.current === token) setError(`Could not copy setup log: ${String(reason)}`);
    } finally {
      if (request.current === token) setCopying(false);
    }
  }
  const close = () => {
    ++request.current;
    onClose();
  };
  return (
    <Modal
      title={`${kind === "speech" ? "Speech" : "Rewriting"} setup log`}
      onClose={close}
      footer={
        <>
          <button
            className="secondary-button"
            disabled={loading || copying}
            onClick={() => void refresh()}
          >
            Refresh
          </button>
          <button
            className="secondary-button"
            disabled={!snapshot || loading || copying}
            onClick={() => void copy()}
          >
            {copying ? "Copying…" : copied ? "Copied" : "Copy log"}
          </button>
          <button className="secondary-button" onClick={close}>
            Close
          </button>
        </>
      }
    >
      <p className="caption">
        The latest setup attempt is kept in memory and resets on the next setup
        or app restart. Refresh to get a new snapshot. Copying is manual and may
        include local paths and technical output.
      </p>
      {loading && <p role="status">Loading setup log…</p>}
      {error && <p role="alert">{error}</p>}
      {copied && <p role="status">Setup log copied.</p>}
      {snapshot && (
        <>
          <p className="caption">
            Local limits: {snapshot.maxEntries} entries and {snapshot.maxCharacters}
            {" "}characters.
            {snapshot.truncated && " This log was truncated to stay within these limits."}
          </p>
          <textarea
            aria-label="Setup log snapshot"
            readOnly
            rows={18}
            className="w-full font-mono text-xs"
            value={formatLog(snapshot)}
          />
        </>
      )}
    </Modal>
  );
}

export function RuntimeSetupLog({ kind }: { kind: "speech" | "rewrite" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="secondary-button" onClick={() => setOpen(true)}>
        Setup log
      </button>
      {open && <SetupLogDialog kind={kind} onClose={() => setOpen(false)} />}
    </>
  );
}
