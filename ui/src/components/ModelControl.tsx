import type * as ipc from "../ipc";
import { IconButton, Line, Segmented, Select } from "./Controls";
import { Icon } from "./Icon";
export type ModelProps = {
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
  download: (id?: string) => Promise<void>;
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
      "Fastest. Parakeet Ultra runs on your graphics card or the processor and hears 25 European languages on its own, but takes no vocabulary.",
  },
];
/** What both layouts of the speech model control need to know. */
function useSpeechModel({
  settings,
  models,
  selectedModel,
  progress,
  update,
}: ModelProps) {
  const percent =
    progress?.totalBytes && progress.id === settings?.model
      ? Math.round((progress.doneBytes / progress.totalBytes) * 100)
      : 0;
  // A failed download belongs to its model, not to the one picked after it.
  const error = progress?.id === settings?.model ? progress?.error : null;
  const engine = selectedModel?.engine ?? "whisper";
  const engineModels = models.filter((m) => m.engine === engine);
  // A downloaded model of the other engine first, so switching back is instant.
  const switchTo = (next: ipc.Engine) => {
    const choices = models.filter((m) => m.engine === next);
    const pick = choices.find((m) => m.downloaded) ?? choices[0];
    if (pick && pick.id !== settings?.model) void update("model", pick.id);
  };
  return { percent, error, engine, engineModels, switchTo };
}

/** The speech model as compact setting lines: engine, model, download. */
export function ModelLines(props: ModelProps & { onModels: () => void }) {
  const {
    settings,
    selectedModel,
    progress,
    downloading,
    modelReady,
    update,
    download,
    cancel,
    onModels,
  } = props;
  const { percent, error, engine, engineModels, switchTo } =
    useSpeechModel(props);
  const about = engines.find((e) => e.value === engine)?.about;
  return (
    <>
      <Line label="Engine" tip={about}>
        <Segmented
          name="engine"
          label="Speech engine"
          value={engine}
          disabled={downloading}
          onChange={switchTo}
          options={engines}
        />
        <IconButton icon="box" label="Manage in Models" onClick={onModels} />
      </Line>
      <Line
        label="Model"
        htmlFor={engineModels.length > 1 ? "model" : undefined}
      >
        {engineModels.length > 1 ? (
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
        ) : (
          <span className="line-value">{selectedModel?.label}</span>
        )}
        {/* A model that asks for credit keeps its licence in view; any
            other shows it at the download. */}
        {selectedModel && (selectedModel.credit || !modelReady) && (
          <LicenceTag model={selectedModel} />
        )}
      </Line>
      {downloading ? (
        <Line label="Downloading">
          <div
            className="bar mini-bar"
            role="progressbar"
            aria-label="Model download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span style={{ transform: `scaleX(${percent / 100})` }} />
          </div>
          <span className="line-note tabular">
            {progress?.totalBytes ? `${percent}%` : "Starting"}
          </span>
          <IconButton icon="close" label="Cancel download" onClick={cancel} />
        </Line>
      ) : (
        !modelReady &&
        selectedModel && (
          <Line label="Not downloaded">
            <span className="line-note tabular">
              {megabytes(selectedModel.bytes)}
            </span>
            <button
              type="button"
              className="button primary small"
              data-tip="Download once, then it works offline"
              onClick={() => void download()}
            >
              <Icon name="download" size={15} />
              {error ? "Try again" : "Download"}
            </button>
          </Line>
        )
      )}
      {error && (
        <p className="line-error" role="alert" data-tip={error}>
          <Icon name="alert" size={15} />
          <span>{error}</span>
        </p>
      )}
    </>
  );
}

/** The licence's short name, shown at the download; opens the licence. */
function LicenceTag({ model }: { model: ipc.ModelStatus }) {
  const tip = model.credit
    ? `${model.credit}. ${model.license} licence`
    : `${model.license} licence`;
  return model.licenseUrl ? (
    <a
      className="tag plain"
      href={model.licenseUrl}
      target="_blank"
      rel="noreferrer"
      data-tip={tip}
    >
      {model.license}
      <Icon name="external" size={11} />
    </a>
  ) : (
    <span className="tag plain" data-tip={tip}>
      {model.license}
    </span>
  );
}

/** Speech engine, then that engine's model, with its download state. */
export function ModelControl(props: ModelProps) {
  const {
    settings,
    selectedModel,
    progress,
    downloading,
    modelReady,
    update,
    download,
    cancel,
  } = props;
  const { percent, error, engine, engineModels, switchTo } =
    useSpeechModel(props);
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
            {error ? "Try again" : "Download"}
          </button>
        </div>
      )}
      {selectedModel?.credit && (
        <p className="model-note">
          {selectedModel.credit}. Licence:{" "}
          {selectedModel.licenseUrl ? (
            <a href={selectedModel.licenseUrl} target="_blank" rel="noreferrer">
              {selectedModel.license}
            </a>
          ) : (
            selectedModel.license
          )}
          .
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={16} />
          {error}
        </p>
      )}
    </div>
  );
}
