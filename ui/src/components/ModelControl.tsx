import type * as ipc from "../ipc";
type Props = {
  settings: ipc.Settings | undefined;
  models: ipc.ModelStatus[];
  selectedModel: ipc.ModelStatus | undefined;
  progress: ipc.ModelDownload | undefined;
  downloading: boolean;
  modelReady: boolean | undefined;
  update: <K extends keyof ipc.Settings>(
    key: K,
    value: ipc.Settings[K],
  ) => Promise<void>;
  download: () => Promise<void>;
  cancel: () => Promise<void>;
};
export function ModelControl({
  settings,
  models,
  selectedModel,
  progress,
  downloading,
  modelReady,
  update,
  download,
  cancel,
}: Props) {
  return (
    <>
      <label htmlFor="model">Model</label>
      <select
        id="model"
        value={settings?.model ?? ""}
        disabled={downloading}
        onChange={(e) => void update("model", e.target.value)}
      >
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      <p className="muted">
        {selectedModel?.downloaded ? "Downloaded" : "Download required"}
        {selectedModel
          ? ` · ${Math.round(selectedModel.bytes / 1000000)} MB`
          : ""}
      </p>
      {downloading && (
        <>
          <progress
            max={progress?.totalBytes || 100}
            value={progress?.doneBytes || 0}
          />
          <p className="muted">
            Downloading{" "}
            {progress?.totalBytes
              ? `${Math.round((progress.doneBytes / progress.totalBytes) * 100)}%`
              : "…"}
          </p>
          <button onClick={() => void cancel()}>Cancel download</button>
        </>
      )}
      {progress?.error && <p className="error">{progress.error}</p>}
      {!downloading && !modelReady && (
        <button onClick={() => void download()}>
          {progress?.error ? "Retry download" : "Download model"}
        </button>
      )}
    </>
  );
}
