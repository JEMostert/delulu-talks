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
