import { useEffect, useState } from "react";
import * as ipc from "../ipc";
import { languageName, toggleLanguage } from "../helpers";
import { Keys, Row, Segmented, Select, Switch } from "../components/Controls";
import { Icon } from "../components/Icon";
import { errorText, type AppState } from "../state";
import { downloadPercent, gigabytes, useMusicModels } from "../useMusicModels";

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
            : settings.language === "auto"
              ? "Automatic picks whichever of your languages you speak."
              : "Every dictation is heard as this language."
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
      {settings.language === "auto" && !parakeet && (
        <AllowedLanguagesRow state={state} />
      )}
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

/** The languages Automatic may pick from, so a short or quiet phrase can't come out
 * as a language the user never speaks. Parakeet can't be limited, so it isn't shown. */
function AllowedLanguagesRow({ state }: Props) {
  const { settings, update, languages } = state;
  if (!settings) return null;
  const allowed = settings.allowedLanguages;
  const set = (code: string) =>
    void update("allowedLanguages", toggleLanguage(allowed, code));
  return (
    <Row
      label="Your languages"
      htmlFor="add-language"
      help="Automatic only chooses from these, so a short or quiet phrase can’t come out in a language you never speak."
    >
      <ul className="lang-set" aria-label="Your languages">
        {allowed.map((code) => (
          <li key={code} className="term">
            <span>{languageName(code, languages)}</span>
            {allowed.length > 1 && (
              <button
                type="button"
                aria-label={`Remove ${languageName(code, languages)}`}
                title={`Remove ${languageName(code, languages)}`}
                onClick={() => set(code)}
              >
                <Icon name="close" size={13} />
              </button>
            )}
          </li>
        ))}
      </ul>
      <Select id="add-language" value="" onChange={(code) => code && set(code)}>
        <option value="">Add…</option>
        {languages
          .filter((l) => !allowed.includes(l.code))
          .map((l) => (
            <option key={l.code} value={l.code}>
              {languageName(l.code, languages)}
            </option>
          ))}
      </Select>
    </Row>
  );
}

/** "F1" → "Female 1", "M3" → "Male 3". */
export function voiceLabel(voice: string) {
  const kind = voice.startsWith("F") ? "Female" : "Male";
  return `${kind} ${voice.slice(1)}`;
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

  const choose = (role: "agent" | "radio", voice: string) =>
    void ipc
      .setVoice(role, voice)
      .then(refresh)
      .catch((e) => setError(errorText(e)));

  const busy = starting || status?.installing;
  const size = status ? `${Math.round(status.modelBytes / 1e6)} MB` : "400 MB";
  return (
    <div className="group">
      <Row
        label="Spoken replies"
        help={
          <>
            <span>
              Optional: agents can speak short replies aloud on this computer,
              in Dutch or English, and Delulu FM gets a host. The voice runs on
              your processor; the model is about {size}.
            </span>
            {status && !status.model && !busy && (
              <span>Model not installed.</span>
            )}
            {status && status.model && !status.engine && (
              <span className="row-error">
                The voice engine is missing. Reinstall Delulu Talks.
              </span>
            )}
            {error && (
              <span className="row-error" role="alert">
                {error}
              </span>
            )}
            {busy && (
              <span>Downloading the voice model. This takes a minute.</span>
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
            disabled={!status || busy || status.model}
            onClick={() => void install()}
          >
            {busy ? "Installing…" : "Install model"}
          </button>
        )}
      </Row>
      {status && !status.model && (
        <Row
          stack
          label={`Licence · ${status.terms.name}`}
          help={
            <>
              <span>
                {status.terms.credit.replace(/\.$/, "")}. Installing the model
                means you agree to its use restrictions. The voices are
                AI-generated: say so wherever you share what they say.
              </span>
              <span className="terms-url">{status.terms.url}</span>
            </>
          }
        >
          <details className="terms">
            <summary>Use restrictions</summary>
            <p>{status.terms.text}</p>
          </details>
        </Row>
      )}
      {status?.model && (
        <>
          <Row
            label="Agent voice"
            htmlFor="agent-voice"
            help="Used by delulu speak. An AI-generated voice."
          >
            <Select
              id="agent-voice"
              value={status.voice}
              onChange={(v) => choose("agent", v)}
            >
              {status.voices.map((v) => (
                <option key={v} value={v}>
                  {voiceLabel(v)}
                </option>
              ))}
            </Select>
          </Row>
          <Row
            label="Radio host voice"
            htmlFor="radio-voice"
            help="Delulu FM's AI host, in the station's language."
          >
            <Select
              id="radio-voice"
              value={status.radioVoice}
              onChange={(v) => choose("radio", v)}
            >
              {status.voices.map((v) => (
                <option key={v} value={v}>
                  {voiceLabel(v)}
                </option>
              ))}
            </Select>
          </Row>
          <Row
            label="Voice model"
            help={`${status.terms.credit}, ${status.terms.name}. Its use restrictions apply to everything the voices say.`}
          >
            <span className="value">{status.modelLabel}</span>
          </Row>
        </>
      )}
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
        help="An optional radio station made on this computer. It needs a music model (YuE2 or ACE-Step, chosen on the Delulu FM page) and a graphics card; nothing is made or played until you press Play."
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

/** What a music model is for, under its name in Settings → Models. */
function modelPurpose(m: ipc.MusicModelRow): string {
  if (m.engine === "yue")
    return "Makes Delulu FM's songs with YuE2 (the default engine). Non-commercial use only.";
  if (m.id === "ace-step-1.5-turbo")
    return "ACE-Step 1.5: text encoder, turbo DiT and VAE. Every ACE-Step song needs these and one language model.";
  if (m.id === "ace-step-1.5-lm-4b")
    return "ACE-Step's larger language model: follows lyrics best; used with at least 8 GB of free graphics memory.";
  return "ACE-Step's small language model: fastest, follows lyrics less closely.";
}

/** Optional models you download and delete yourself. */
export function ModelsSection() {
  const { models, error, run } = useMusicModels();
  const [confirming, setConfirming] = useState<string | null>(null);
  const downloading = models?.models.some((m) => m.state === "downloading");
  const percent = downloadPercent(models);
  return (
    <div className="group">
      {error && (
        <p className="row-error" role="alert">
          {error}
        </p>
      )}
      {models?.models.map((m) => (
        <Row
          key={m.id}
          stack
          label={`Music model · ${m.label}`}
          help={
            <span>
              {modelPurpose(m)} {gigabytes(m.bytes)} on disk; only needed for
              Delulu FM. License: {m.license}.
            </span>
          }
        >
          <div className="model">
            {m.state === "downloading" ? (
              <div className="model-state">
                <div
                  className="bar"
                  role="progressbar"
                  aria-label={`${m.label} download`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                >
                  <span style={{ transform: `scaleX(${percent / 100})` }} />
                </div>
                <span className="model-note tabular">
                  {models.doneBytes ? `${percent}%` : "Starting…"}
                </span>
                <button
                  type="button"
                  className="button quiet"
                  onClick={() => void run(ipc.cancelMusicDownload)}
                >
                  Cancel
                </button>
              </div>
            ) : m.state === "ready" ? (
              <div className="model-state">
                <span className="model-ready">
                  <Icon name="check" size={16} />
                  On this computer
                </span>
                <span className="model-note">{gigabytes(m.bytes)}</span>
                {confirming === m.id ? (
                  <>
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        setConfirming(null);
                        void run(() => ipc.deleteMusicModel(m.id));
                      }}
                    >
                      Delete it
                    </button>
                    <button
                      type="button"
                      className="button quiet"
                      onClick={() => setConfirming(null)}
                    >
                      Keep
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="button quiet"
                    disabled={downloading}
                    onClick={() => setConfirming(m.id)}
                  >
                    Delete
                  </button>
                )}
              </div>
            ) : (
              <div className="model-state">
                <span className="model-note">
                  {gigabytes(m.bytes)} download, then it works offline
                </span>
                <button
                  type="button"
                  className="button primary"
                  disabled={downloading}
                  onClick={() => void run(() => ipc.downloadMusicModel([m.id]))}
                >
                  <Icon name="download" size={16} />
                  {models.error ? "Try again" : "Download"}
                </button>
              </div>
            )}
          </div>
        </Row>
      ))}
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
      <Row
        label="Voices"
        help="Spoken replies and Delulu FM's host use AI-generated voices."
      >
        <span className="value">
          Supertonic 3 by Supertone Inc. (OpenRAIL-M)
        </span>
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
