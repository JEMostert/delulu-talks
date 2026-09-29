import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { bridge } from "../bridge";
import type { LocalDataOverview } from "../types";
import { Alert } from "./ui";

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export function LocalData() {
  const [data, setData] = useState<LocalDataOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      setData(await bridge.getLocalDataOverview());
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
    <section className="card" aria-label="Local data overview">
      <div className="section-heading">
        <div>
          <h3>Local data</h3>
          <p className="caption">
            Inspect what this app keeps on your device. Refreshing only reads
            file metadata.
          </p>
        </div>
        <button
          className="tool-button"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw className={busy ? "spin" : ""} />
          {busy ? "Scanning…" : "Refresh local data"}
        </button>
      </div>
      {error && <Alert>{error} Use Refresh local data to try again.</Alert>}
      {data && (
        <>
          <p className="caption break-all mt-4">
            App data: {data.dataDirectory}
          </p>
          <p className="caption">
            Checked {new Date(data.checkedAt).toLocaleString()}. Sizes are
            logical file bytes, not disk allocation. Links are excluded to avoid
            counting shared model blobs twice or scanning outside the app. Files
            may change during a scan.
          </p>
          {data.categories.map((category) => (
            <section
              key={category.id}
              className="settings-group mt-4"
              aria-label={category.label}
            >
              <div className="group-heading">
                <h4>{category.label}</h4>
                <p>{category.description}</p>
              </div>
              <ul className="space-y-3 px-5 py-4">
                {category.locations.map((location) => (
                  <li key={location.path} className="text-sm">
                    <code className="block break-all">{location.path}</code>
                    <span className="text-muted">
                      {location.status === "missing"
                        ? "Not present"
                        : `${location.status === "partial" ? "Partial scan · at least " : ""}${size(location.bytes)} · ${location.files} files`}
                      {location.skippedLinks > 0 &&
                        ` · ${location.skippedLinks} links excluded`}
                    </span>
                    {location.problems.length > 0 && (
                      <p className="caption break-all" role="status">
                        {location.problems.join("; ")}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <p className="caption">
            This overview covers app-managed data at the paths above. Other app
            files, external backups, exports and imported audio are not
            included. No data is removed here.
          </p>
        </>
      )}
    </section>
  );
}
