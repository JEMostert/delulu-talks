import { useEffect, useState } from "react";
import * as ipc from "../ipc";
import { languageName } from "../helpers";
import { Keys, Row, Segmented, Select, Switch } from "../components/Controls";
import { Icon } from "../components/Icon";
import { errorText, type AppState } from "../state";

type Props = { state: AppState };
/** From package.json, set by Vite. */
declare const __APP_VERSION__: string;

export function InputSection({ state }: Props) {
  const { settings, status, microphones, update, hotkeyHint, setHotkeyHint } =
    state;
  if (!settings || !status) return null;
  return (
    <div className="group">
      <Row label="Microphone" htmlFor="mic">
        <Select
          id="mic"
          value={settings.microphone ?? ""}
          onChange={(value) => void update("microphone", value || null)}
        >
          <option value="">System default</option>
          {microphones.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.isDefault ? " (default)" : ""}
            </option>
          ))}
        </Select>
      </Row>
      <Row
        label="Hotkey"
        help={
          <>
            {status.hotkey.error && (
              <span className="row-error">{status.hotkey.error}</span>
            )}
            {hotkeyHint ? (
              <span>
                Pick a new key in the window that opened, or in your system’s
                shortcut settings.
              </span>
            ) : (
              <span>Hold to talk, or tap to start and stop.</span>
            )}
          </>
        }
      >
        <Keys trigger={status.hotkey.trigger} />
        <button
          type="button"
          className="button"
          onClick={() =>
            void ipc
              .changeHotkey()
              .then(() => setHotkeyHint(true))
              .catch((e) => state.setNotice(errorText(e)))
          }
        >
          Change…
        </button>
      </Row>
      <Row
        label="Start at login"
        htmlFor="login"
        help="Be ready to listen as soon as you sign in."
      >
        <Switch
          id="login"
          checked={settings.startAtLogin}
          onChange={(value) => void update("startAtLogin", value)}
        />
      </Row>
    </div>
  );
}

export function DictationSection({ state }: Props) {
  const { settings, update, modelControl, languages, models } = state;
  if (!settings) return null;
  const parakeet =
    models.find((m) => m.id === settings.model)?.engine === "parakeet";
  return (
    <div className="group">
      <Row
        label="Speech engine"
        help="Both run on this computer; nothing you say leaves it."
        stack
      >
        {modelControl}
      </Row>
      <Row
        label="Language"
        htmlFor="language"
        help={
          parakeet
            ? "Parakeet always hears the language itself. A fixed language tells cleanup what to expect."
            : "Automatic follows whatever you speak."
        }
      >
        <Select
          id="language"
          value={settings.language}
          onChange={(value) => void update("language", value)}
        >
          <option value="auto">Automatic</option>
          {languages.map((l) => (
            <option key={l.code} value={l.code}>
              {languageName(l.code, languages)}
            </option>
          ))}
        </Select>
      </Row>
      <Row
        label="Smart context management"
        htmlFor="smart-context"
        help="Remembers what you were just talking about, so the next dictation gets names and terms right. Forgotten after 10 quiet minutes, a restart, or Clear topic in the tray."
      >
        <Switch
          id="smart-context"
          checked={settings.smartContext}
          onChange={(value) => void update("smartContext", value)}
        />
      </Row>
      <Row
        label="Insert text with"
        htmlFor="insert"
        help="The keys used to paste into the app you’re in."
      >
        <Select
          id="insert"
          value={settings.insert}
          onChange={(value) =>
            void update("insert", value as ipc.Settings["insert"])
          }
        >
          <option value="shift-insert">Shift+Insert</option>
          <option value="ctrl-v">Ctrl+V</option>
          <option value="ctrl-shift-v">Ctrl+Shift+V</option>
          <option value="off">Off (copy only)</option>
        </Select>
      </Row>
    </div>
  );
}

export function VoiceSection() {
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
      await refresh();
    } catch (e) {
      setError(errorText(e));
      await ipc
        .getVoiceStatus()
        .then(setStatus)
        .catch(() => {});
    } finally {
      setStarting(false);
    }
  };

  const busy = starting || status?.installing;
  return (
    <div className="group">
      <Row
        label="Spoken replies"
        help={
          <>
            <span>
              Optional: ask your agent to speak a reply aloud on this computer.
              Installing the model downloads about 3 GB.
            </span>
            {status && !status.ready && !busy && (
              <span>Model not installed.</span>
            )}
            {error && (
              <span className="row-error" role="alert">
                {error}
              </span>
            )}
            {busy && (
              <span>Installing the model. This may take a few minutes.</span>
            )}
          </>
        }
      >
        {status?.ready && !busy ? (
          <span className="model-ready" role="status">
            Ready
          </span>
        ) : error && !status ? (
          <button
            type="button"
            className="button"
            onClick={() => void refresh()}
          >
            Retry
          </button>
        ) : (
          <button
            type="button"
            className="button"
            disabled={!status || busy}
            onClick={() => void install()}
          >
            {busy ? "Installing…" : "Install model"}
          </button>
        )}
      </Row>
    </div>
  );
}

export function RadioSection({ state }: Props) {
  const { settings, update } = state;
  if (!settings) return null;
  return (
    <div className="group">
      <Row
        label="Show Delulu FM"
        htmlFor="radio"
        help="An optional radio station made on this computer. It needs the music model (Settings → Models) and a graphics card; nothing is made or played until you press Play."
      >
        <Switch
          id="radio"
          checked={settings.radio}
          onChange={(value) => void update("radio", value)}
        />
      </Row>
    </div>
  );
}

const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** Optional models you download and delete yourself. */
export function ModelsSection() {
  const [model, setModel] = useState<ipc.MusicModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    ipc
      .getMusicModel()
      .then(setModel)
      .catch((e) => setError(errorText(e)));
    const off = ipc.onMusicModel((m) => {
      setModel(m);
      setError(null);
    });
    return () => void off.then((f) => f());
  }, []);

  const run = async (action: () => Promise<ipc.MusicModel | void>) => {
    setError(null);
    try {
      const next = await action();
      if (next) setModel(next);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const percent =
    model?.state === "downloading" && model.totalBytes
      ? Math.round((model.doneBytes / model.totalBytes) * 100)
      : 0;
  const problem = error ?? model?.error ?? null;
  return (
    <div className="group">
      <Row
        stack
        label={`Music model${model ? ` · ${model.label}` : ""}`}
        help={
          <>
            <span>
              Makes Delulu FM&apos;s songs on your graphics card. About{" "}
              {gigabytes(model?.totalBytes ?? 3.96e9)} on disk; only needed for
              Delulu FM. License: {model?.license ?? "CC BY-NC 4.0"}{" "}
              (non-commercial use).
            </span>
            {problem && (
              <span className="row-error" role="alert">
                {problem}
              </span>
            )}
          </>
        }
      >
        <div className="model">
          {!model ? null : model.state === "downloading" ? (
            <div className="model-state">
              <div
                className="bar"
                role="progressbar"
                aria-label="Music model download"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <span style={{ transform: `scaleX(${percent / 100})` }} />
              </div>
              <span className="model-note tabular">
                {model.doneBytes ? `${percent}%` : "Starting…"}
              </span>
              <button
                type="button"
                className="button quiet"
                onClick={() => void run(ipc.cancelMusicDownload)}
              >
                Cancel
              </button>
            </div>
          ) : model.state === "ready" ? (
            <div className="model-state">
              <span className="model-ready">
                <Icon name="check" size={16} />
                On this computer
              </span>
              <span className="model-note">{gigabytes(model.totalBytes)}</span>
              {confirming ? (
                <>
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      setConfirming(false);
                      void run(ipc.deleteMusicModel);
                    }}
                  >
                    Delete it
                  </button>
                  <button
                    type="button"
                    className="button quiet"
                    onClick={() => setConfirming(false)}
                  >
                    Keep
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="button quiet"
                  onClick={() => setConfirming(true)}
                >
                  Delete
                </button>
              )}
            </div>
          ) : (
            <div className="model-state">
              <span className="model-note">
                {gigabytes(model.totalBytes)} download, then it works offline
              </span>
              <button
                type="button"
                className="button primary"
                onClick={() => void run(ipc.downloadMusicModel)}
              >
                <Icon name="download" size={16} />
                {model.error ? "Try again" : "Download"}
              </button>
            </div>
          )}
        </div>
      </Row>
    </div>
  );
}

export function AppearanceSection({ state }: Props) {
  const { settings, update } = state;
  if (!settings) return null;
  return (
    <div className="group">
      <Row label="Theme">
        <Segmented
          name="theme"
          label="Theme"
          value={settings.theme}
          onChange={(value) => void update("theme", value)}
          options={[
            { value: "system", label: "System", icon: "system" },
            { value: "light", label: "Light", icon: "sun" },
            { value: "dark", label: "Dark", icon: "moon" },
          ]}
        />
      </Row>
      <Row
        label="Show recording pill"
        htmlFor="overlay"
        help="A small pearl at the bottom of the screen while you dictate."
      >
        <span className="pill-preview" aria-hidden="true">
          <span />
        </span>
        <Switch
          id="overlay"
          checked={settings.overlay}
          onChange={(value) => void update("overlay", value)}
        />
      </Row>
    </div>
  );
}

export function AboutSection({ state }: Props) {
  const { status, setNotice } = state;
  if (!status) return null;
  return (
    <div className="group">
      <Row label="Version">
        <span className="value tabular">{__APP_VERSION__}</span>
      </Row>
      <Row label="Speech runs on">
        <span className="value">{status.backend ?? "Not loaded yet"}</span>
      </Row>
      <Row label="Data folder" help="Transcripts, settings and models.">
        <span className="value path">{status.dataDir}</span>
      </Row>
      <Row label="Project page" help="Source code, issues and releases.">
        <button
          type="button"
          className="button"
          onClick={() =>
            void ipc.openProjectPage().catch((e) => setNotice(errorText(e)))
          }
        >
          Open
          <Icon name="external" size={15} />
        </button>
      </Row>
    </div>
  );
}
