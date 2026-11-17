import { useEffect, useRef, useState, type ReactNode } from "react";
import * as ipc from "../ipc";
import { IconButton, Segmented, Tag } from "../components/Controls";
import { Icon } from "../components/Icon";
import { errorText, type AppState } from "../state";
import { downloadPercent, gigabytes, useMusicModels } from "../useMusicModels";

/** What a licence tag opens: the short name, who made the model, the terms. */
type Licence = {
  name: string;
  credit?: string | null;
  url?: string | null;
  text?: string | null;
};
/** Shown before a download whose licence must be accepted first. */
type Accept = { label: string; onAccept: () => void };
type ModelRow = {
  id: string;
  name: string;
  /** Extra words about the model, in its name's tooltip. */
  tip?: string;
  usedBy: string;
  licence: Licence;
  /** On disk (or to download); null when unknown. */
  bytes: number | null;
  /** The model's files are on this computer. */
  present: boolean;
  action: ReactNode;
  /** Delete, for models the app can delete. */
  remove?: ReactNode;
};
type Group = { name: string; extra?: ReactNode; rows: ModelRow[] };

const WHISPER_LICENCE = "https://github.com/openai/whisper/blob/main/LICENSE";
const GEMMA_PAGE = "https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf";
const GEMMA_BYTES = 5_154_941_280;
const VOICE_BYTES = 401_291_751;
/** Licence pages for models whose catalogue entry names none. */
const licenceUrls: Record<string, string> = {
  "CC BY-NC 4.0": "https://creativecommons.org/licenses/by-nc/4.0/",
  "CC BY 4.0": "https://creativecommons.org/licenses/by/4.0/",
};
const lmLabels: Record<ipc.AceLm, string> = {
  auto: "Auto",
  "0.6b": "0.6B",
  "4b": "4B",
};
const lmOf: Record<string, ipc.AceLm> = {
  "ace-step-1.5-lm-0.6b": "0.6b",
  "ace-step-1.5-lm-4b": "4b",
};

/** "Large v3 Turbo (recommended)" → name "Whisper Large v3 Turbo", tip "recommended". */
function speechName(m: ipc.ModelStatus) {
  const match = /^(.*?)\s*\((.*)\)$/.exec(m.label);
  const base = match ? match[1] : m.label;
  return {
    name: m.engine === "whisper" ? `Whisper ${base}` : base,
    tip: match?.[2],
  };
}

const percentOf = (done: number, total: number) =>
  total ? Math.round((done / total) * 100) : null;

/** The voice model's state, refreshed while it installs. */
function useVoiceModel() {
  const [status, setStatus] = useState<ipc.VoiceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const refresh = async () => {
    try {
      setStatus(await ipc.getVoiceStatus());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (!status?.installing) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [status?.installing]);
  const install = async () => {
    setStarting(true);
    setError(null);
    try {
      await ipc.installVoiceModel();
    } catch (e) {
      setError(errorText(e));
    } finally {
      await refresh().catch(() => {});
      setStarting(false);
    }
  };
  return {
    status,
    error,
    busy: starting || Boolean(status?.installing),
    refresh,
    install,
  };
}

/** Every model the app uses, in one table: what it is for, its licence, its size, what to do. */
export function Models({ state }: { state: AppState }) {
  const { status, settings, models, modelProps, update, cleanupStatus } = state;
  const music = useMusicModels();
  const voice = useVoiceModel();
  const [licence, setLicence] = useState<{
    licence: Licence;
    accept?: Accept;
  }>();
  if (!status || !settings) return null;
  const open = (l: Licence, accept?: Accept) =>
    setLicence({ licence: l, accept });
  const fail = (e: unknown) => state.setNotice(errorText(e));

  // Speech: Use switches the model exactly as Dictate's control does.
  const { progress, downloading } = modelProps;
  const speechRows = models.map((m): ModelRow => {
    const { name, tip } = speechName(m);
    const busy = downloading && progress?.id === m.id;
    const error = !busy && progress?.id === m.id ? progress.error : null;
    const selected = settings.model === m.id;
    let action: ReactNode;
    if (busy)
      action = (
        <Progress
          label={`${name} download`}
          percent={percentOf(progress.doneBytes, progress.totalBytes)}
          onCancel={() => void modelProps.cancel()}
        />
      );
    else if (!m.downloaded)
      action = (
        <>
          {error && <Failed error={error} />}
          <Download
            licence={m.license}
            retry={Boolean(error)}
            disabled={downloading}
            onClick={() => void modelProps.download(m.id)}
          />
        </>
      );
    else if (selected) action = <InUse />;
    else
      action = (
        <button
          type="button"
          className="button small"
          disabled={downloading}
          onClick={() => void update("model", m.id)}
        >
          Use
        </button>
      );
    return {
      id: m.id,
      name,
      tip: m.replaces ? `Replaces ${m.replaces}` : tip,
      usedBy: "Dictate",
      licence: {
        name: m.license,
        credit: m.credit,
        url:
          m.licenseUrl ??
          (m.engine === "whisper" ? WHISPER_LICENCE : licenceUrls[m.license]),
      },
      bytes: m.bytes,
      present: m.downloaded,
      action,
    };
  });

  // Cleanup: Gemma, as Clean up text on Dictate shows it.
  const cs = cleanupStatus;
  const cleanupError = cs?.state === "error" || cs?.error ? cs.error : null;
  const cleanupAction: ReactNode = !cs ? null : cs.state === "off" ? (
    <button
      type="button"
      className="button small"
      data-tip="Turns on Clean up text"
      onClick={() => void update("cleanup", true)}
    >
      Use
    </button>
  ) : cs.state === "downloading" ? (
    <Progress
      label="Gemma 4 E4B download"
      percent={percentOf(cs.doneBytes, cs.totalBytes)}
      onCancel={() => void ipc.cancelCleanupDownload().catch(fail)}
    />
  ) : cs.state === "loading" ? (
    <Tag>Loading</Tag>
  ) : cs.state === "ready" ? (
    <InUse tip={cs.backend ?? undefined} />
  ) : (
    <>
      {cleanupError && <Failed error={cleanupError} />}
      <Download
        licence="Gemma"
        retry={cs.state === "error" || Boolean(cleanupError)}
        onClick={() => void ipc.startCleanup().catch(fail)}
      />
    </>
  );
  const cleanupRow: ModelRow = {
    id: "gemma-4-e4b",
    name: "Gemma 4 E4B",
    usedBy: "Dictate · Delulu FM",
    licence: {
      name: "Gemma",
      credit: "Gemma 4 E4B by Google",
      url: GEMMA_PAGE,
    },
    bytes: cs?.totalBytes || GEMMA_BYTES,
    present: cs?.state === "ready" || cs?.state === "loading",
    action: cleanupAction,
  };

  // Voice: Supertonic 3; its licence is accepted before the download.
  const vs = voice.status;
  const voiceLicence: Licence = vs
    ? {
        name: vs.terms.name.replace(/^BigScience\s+/, ""),
        credit: vs.terms.credit,
        url: vs.terms.url,
        text: vs.terms.text,
      }
    : { name: "OpenRAIL-M", credit: "Supertonic 3 by Supertone Inc." };
  const voiceAction: ReactNode = voice.busy ? (
    <Progress label="Voice model download" percent={null} />
  ) : !vs ? (
    voice.error && (
      <>
        <Failed error={voice.error} />
        <button
          type="button"
          className="button small"
          onClick={() => void voice.refresh()}
        >
          Retry
        </button>
      </>
    )
  ) : vs.model && !vs.engine ? (
    <Tag tone="warn" tip="The voice engine is missing. Reinstall Delulu Talks.">
      Engine missing
    </Tag>
  ) : vs.model ? (
    <InUse />
  ) : (
    <>
      {voice.error && <Failed error={voice.error} />}
      <Download
        licence={voiceLicence.name}
        retry={Boolean(voice.error)}
        onClick={() =>
          open(voiceLicence, {
            label: "Accept and download",
            onAccept: () => void voice.install(),
          })
        }
      />
    </>
  );
  const voiceRow: ModelRow = {
    id: "supertonic-3",
    name: vs?.modelLabel ?? "Supertonic 3",
    tip: "AI-generated voices: say so wherever you share what they say",
    usedBy: "Voice · Delulu FM host",
    licence: voiceLicence,
    bytes: vs?.modelBytes ?? VOICE_BYTES,
    present: Boolean(vs?.model),
    action: voiceAction,
  };

  // Music: YuE2 and ACE-Step's parts. Use picks Delulu FM's engine.
  const radio = state.radio.view?.radio;
  const engine = radio?.music;
  const mm = music.models;
  const musicBusy = mm?.models.some((m) => m.state === "downloading") ?? false;
  const musicPercent = mm?.totalBytes ? downloadPercent(mm) : null;
  const choose = (next: ipc.MusicEngine, lm: ipc.AceLm) =>
    void state.radio.act(() => ipc.radioMusic(next, lm));
  const musicRows = (mm?.models ?? []).map((m): ModelRow => {
    const lm = lmOf[m.id];
    const error = music.errorFor(m.id);
    const ace = engine?.engine === "acestep";
    const inUse = lm
      ? ace && (engine.aceLm === lm || engine.aceLm === "auto")
      : engine?.engine === (m.engine === "yue" ? "yue2" : "acestep");
    let action: ReactNode;
    if (mm?.unavailable)
      // Why is in the Music group's header (music.error).
      action = null;
    else if (m.state === "downloading")
      action = (
        <Progress
          label={`${m.label} download`}
          percent={musicPercent}
          onCancel={() => void music.run(ipc.cancelMusicDownload, [m.id])}
        />
      );
    else if (m.state === "missing")
      action = (
        <>
          {error && <Failed error={error} />}
          <Download
            licence={m.license}
            retry={Boolean(error)}
            disabled={musicBusy}
            onClick={() =>
              void music.run(() => ipc.downloadMusicModel([m.id]), [m.id])
            }
          />
        </>
      );
    else
      action = (
        <>
          {error && <Failed error={error} />}
          {inUse && lm && engine?.aceLm === "auto" ? (
            <Tag tip="Automatic: 4B with 8 GB of free graphics memory, else 0.6B">
              Auto
            </Tag>
          ) : inUse ? (
            <InUse />
          ) : (
            radio &&
            !lm && (
              <button
                type="button"
                className="button small"
                data-tip="Applies from the next song"
                onClick={() =>
                  choose(
                    m.engine === "yue" ? "yue2" : "acestep",
                    radio.music.aceLm,
                  )
                }
              >
                Use
              </button>
            )
          )}
        </>
      );
    return {
      id: m.id,
      name: m.label === "YuE2 3B" ? "YuE2" : m.label,
      tip: m.engine === "yue" ? "Non-commercial use only" : undefined,
      usedBy: "Delulu FM",
      licence: {
        name: m.license,
        credit: m.terms?.credit,
        url: m.terms?.url ?? licenceUrls[m.license],
        text: m.terms?.text,
      },
      bytes: m.bytes,
      present: m.state === "ready",
      action,
      remove: m.state === "ready" && !mm?.unavailable && (
        <Delete
          name={m.label}
          disabled={musicBusy}
          onDelete={() =>
            void music.run(() => ipc.deleteMusicModel(m.id), [m.id])
          }
        />
      ),
    };
  });
  const musicExtra = (
    <>
      {radio?.readiness && !radio.readiness.music.engine && (
        <Tag
          tone="warn"
          tip="The music engine is missing. Reinstall Delulu Talks."
        >
          Engine missing
        </Tag>
      )}
      {engine?.engine === "acestep" && (
        <span data-tip="ACE-Step language model">
          <Segmented
            name="ace-lm"
            label="ACE-Step language model"
            value={engine.aceLm}
            onChange={(lm) => choose("acestep", lm)}
            options={(["auto", "0.6b", "4b"] as const).map((value) => ({
              value,
              label: lmLabels[value],
            }))}
          />
        </span>
      )}
      {music.error && <Failed error={music.error} />}
    </>
  );

  const groups: Group[] = [
    { name: "Speech", rows: speechRows },
    { name: "Cleanup", rows: [cleanupRow] },
    { name: "Voice", rows: [voiceRow] },
    { name: "Music", extra: musicExtra, rows: musicRows },
  ];
  const total = groups
    .flatMap((g) => g.rows)
    .reduce((sum, r) => sum + (r.present && r.bytes ? r.bytes : 0), 0);
  const modelsDir = `${status.dataDir}/models`;

  return (
    <div className="models">
      <h1>Models</h1>
      <div className="models-card glass-card">
        <table className="models-table">
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Used by</th>
              <th scope="col">Licence</th>
              <th scope="col" className="num">
                Size
              </th>
              <th scope="col" className="act">
                <span className="visually-hidden">State</span>
              </th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.name}>
              <tr className="models-group">
                <th scope="colgroup" colSpan={4}>
                  {g.name}
                </th>
                <td className="act">
                  {g.extra && <div className="models-extra">{g.extra}</div>}
                </td>
              </tr>
              {g.rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row" className="models-name">
                    <span data-tip={r.tip}>{r.name}</span>
                  </th>
                  <td className="muted">{r.usedBy}</td>
                  <td>
                    <LicenceTag licence={r.licence} onOpen={open} />
                  </td>
                  <td className="num muted tabular">
                    {r.bytes ? gigabytes(r.bytes) : "–"}
                  </td>
                  <td className="act">
                    <div className="models-action">
                      {r.action}
                      <span className="models-remove">{r.remove}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      <footer className="models-foot">
        <span data-tip="Models on this computer">
          <Icon name="disk" size={16} />
          <span className="tabular">{gigabytes(total)} of models</span>
        </span>
        <span data-tip="Where speech runs">
          <Icon name="chip" size={16} />
          {status.backend ?? "Not loaded yet"}
        </span>
        <button
          type="button"
          className="button quiet small models-folder"
          data-tip={modelsDir}
          onClick={() => void ipc.openFolder(modelsDir).catch(fail)}
        >
          <Icon name="folder" size={16} />
          Open folder
        </button>
      </footer>
      {licence && (
        <LicenceDialog
          licence={licence.licence}
          accept={licence.accept}
          onClose={() => setLicence(undefined)}
        />
      )}
    </div>
  );
}

function InUse({ tip }: { tip?: string }) {
  return (
    <Tag tone="ok" tip={tip}>
      <Icon name="check" size={12} />
      In use
    </Tag>
  );
}

/** A download in progress; `percent` null while it starts or has no size. */
function Progress({
  label,
  percent,
  onCancel,
}: {
  label: string;
  percent: number | null;
  onCancel?: () => void;
}) {
  return (
    <>
      <div
        className="bar mini-bar models-bar"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <span style={{ transform: `scaleX(${(percent ?? 4) / 100})` }} />
      </div>
      <span className="models-note tabular">
        {percent == null ? "Starting" : `${percent}%`}
      </span>
      {onCancel && (
        <IconButton icon="close" label="Cancel download" onClick={onCancel} />
      )}
    </>
  );
}

/** An error, as an alert icon whose tooltip and description carry the message. */
function Failed({ error }: { error: string }) {
  return (
    <span className="models-error" role="alert" data-tip={error} tabIndex={0}>
      <Icon name="alert" size={16} />
      <span className="visually-hidden">{error}</span>
    </span>
  );
}

/** Download; the licence's short name is the tag in the same row, and in the button's name. */
function Download({
  licence,
  retry,
  disabled,
  onClick,
}: {
  licence: string;
  retry?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="button primary small"
      data-tip={`${licence} licence · works offline after the download`}
      aria-label={`${retry ? "Retry download" : "Download"} (${licence} licence)`}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name="download" size={15} />
      {retry ? "Retry" : "Download"}
    </button>
  );
}

/** Delete, after a second press to confirm. */
function Delete({
  name,
  disabled,
  onDelete,
}: {
  name: string;
  disabled?: boolean;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming)
    return (
      <IconButton
        icon="trash"
        label={`Delete ${name}`}
        tone="danger"
        disabled={disabled}
        onClick={() => setConfirming(true)}
      />
    );
  return (
    <>
      <button
        type="button"
        className="button danger small"
        autoFocus
        onClick={() => {
          setConfirming(false);
          onDelete();
        }}
      >
        Delete
      </button>
      <IconButton
        icon="close"
        label="Keep it"
        onClick={() => setConfirming(false)}
      />
    </>
  );
}

function LicenceTag({
  licence,
  onOpen,
}: {
  licence: Licence;
  onOpen: (l: Licence) => void;
}) {
  return (
    <button
      type="button"
      className="tag plain models-licence"
      data-tip={licence.credit ?? "Open licence"}
      aria-label={`${licence.name} licence`}
      onClick={() => onOpen(licence)}
    >
      {licence.name}
      <Icon name="external" size={11} />
    </button>
  );
}

/** The licence, outside the page: who made the model, its terms and the full text's page. */
function LicenceDialog({
  licence,
  accept,
  onClose,
}: {
  licence: Licence;
  accept?: Accept;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);
  const url = licence.url;
  return (
    <dialog
      ref={dialog}
      className="models-dialog"
      aria-labelledby="licence-title"
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog itself.
        if (e.target === e.currentTarget) dialog.current?.close();
      }}
    >
      <header className="models-dialog-head">
        <h2 id="licence-title">{licence.name}</h2>
        <IconButton
          icon="close"
          label="Close"
          onClick={() => dialog.current?.close()}
        />
      </header>
      {licence.credit && <p className="muted">{licence.credit}</p>}
      {licence.text && <p className="models-terms">{licence.text}</p>}
      {accept && (
        <p className="muted">
          Downloading means you accept these terms. The voices are AI-generated:
          say so wherever you share what they say.
        </p>
      )}
      <footer className="models-dialog-foot">
        {url && (
          <button
            type="button"
            className="button quiet small"
            data-tip={url}
            onClick={() => void ipc.openLicence(url).catch(() => {})}
          >
            Full licence
            <Icon name="external" size={14} />
          </button>
        )}
        {accept && (
          <button
            type="button"
            className="button primary small"
            onClick={() => {
              accept.onAccept();
              dialog.current?.close();
            }}
          >
            <Icon name="download" size={15} />
            {accept.label}
          </button>
        )}
      </footer>
    </dialog>
  );
}
