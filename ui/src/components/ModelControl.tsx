import type * as ipc from "../ipc";
import { Segmented, Select } from "./Controls";
import { Icon } from "./Icon";
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
const megabytes = (bytes: number) => `${Math.round(bytes / 1000000)} MB`;
const engines: { value: ipc.Engine; label: string; about: string }[] = [
  {
    value: "whisper",
    label: "Whisper",
    about:
      "Most accurate. Runs on your graphics card and follows your language setting and recent context.",
  },
  {
    value: "parakeet",
    label: "Parakeet",
    about:
      "Fastest. Runs on the processor and recognizes 25 European languages on its own.",
  },
];
/** Speech engine, then that engine's model, with its download state. */
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
  const percent =
    progress?.totalBytes && progress.id === settings?.model
      ? Math.round((progress.doneBytes / progress.totalBytes) * 100)
      : 0;
  const engine = selectedModel?.engine ?? "whisper";
  const engineModels = models.filter((m) => m.engine === engine);
  // A downloaded model of the other engine first, so switching back is instant.
  const switchTo = (next: ipc.Engine) => {
    const choices = models.filter((m) => m.engine === next);
    const pick = choices.find((m) => m.downloaded) ?? choices[0];
    if (pick && pick.id !== settings?.model) void update("model", pick.id);
  };
  return (
    <div className="model">
      <Segmented
        name="engine"
        label="Speech engine"
        value={engine}
        disabled={downloading}
        onChange={switchTo}
        options={engines}
      />
      <p className="model-about">
        {engines.find((e) => e.value === engine)?.about}
      </p>
      {engineModels.length > 1 && (
        <Select
          id="model"
          value={settings?.model ?? ""}
          disabled={downloading}
          onChange={(value) => void update("model", value)}
        >
          {engineModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>
      )}
      {downloading ? (
        <div className="model-state">
          <div
            className="bar"
            role="progressbar"
            aria-label="Model download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span style={{ transform: `scaleX(${percent / 100})` }} />
          </div>
          <span className="model-note tabular">
            {progress?.totalBytes ? `${percent}%` : "Starting…"}
          </span>
          <button
            type="button"
            className="button quiet"
            onClick={() => void cancel()}
          >
            Cancel
          </button>
        </div>
      ) : modelReady ? (
        <div className="model-state">
          <span className="model-ready">
            <Icon name="check" size={16} />
            On this computer
          </span>
          {selectedModel && (
            <span className="model-note">{megabytes(selectedModel.bytes)}</span>
          )}
        </div>
      ) : (
        <div className="model-state">
          <span className="model-note">
            {selectedModel
              ? `${megabytes(selectedModel.bytes)} download, then it works offline`
              : "Pick a model to download"}
          </span>
          <button
            type="button"
            className="button primary"
            onClick={() => void download()}
          >
            <Icon name="download" size={16} />
            {progress?.error ? "Try again" : "Download"}
          </button>
        </div>
      )}
      {progress?.error && (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={16} />
          {progress.error}
        </p>
      )}
    </div>
  );
}
