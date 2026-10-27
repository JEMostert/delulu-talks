import * as ipc from "../ipc";
import { languageName } from "../helpers";
import { errorText, type AppState } from "../state";
export function Settings({ state }: { state: AppState }) {
  const {
    settings,
    status,
    microphones,
    update,
    trigger,
    hotkeyHint,
    setHotkeyHint,
    setNotice,
    modelControl,
    languages,
  } = state;
  if (!settings || !status) return null;
  return (
    <>
      <div className="page-heading">
        <h1>Settings</h1>
        <p>Make Delulu Talks yours.</p>
      </div>
      <section className="settings-section">
        <h2>Input</h2>
        <div className="setting">
          <label htmlFor="mic">Microphone</label>
          <select
            id="mic"
            value={settings.microphone ?? ""}
            onChange={(e) => void update("microphone", e.target.value || null)}
          >
            <option value="">System default</option>
            {microphones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.isDefault ? " (default)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="setting">
          <div>
            <span>Hotkey: {trigger}</span>
            {status.hotkey.error && (
              <p className="error">{status.hotkey.error}</p>
            )}
            {hotkeyHint && (
              <p className="muted">
                Change it in GNOME Settings › Apps › Delulu Talks.
              </p>
            )}
          </div>
          <button
            onClick={() =>
              void ipc
                .changeHotkey()
                .then(() => setHotkeyHint(true))
                .catch((e) => setNotice(errorText(e)))
            }
          >
            Change…
          </button>
        </div>
        <div className="setting">
          <label htmlFor="login">Start at login</label>
          <input
            id="login"
            type="checkbox"
            checked={settings.startAtLogin}
            onChange={(e) => void update("startAtLogin", e.target.checked)}
          />
        </div>
      </section>
      <section className="settings-section">
        <h2>Dictation</h2>
        <div className="setting model-setting">
          <div>{modelControl}</div>
        </div>
        <div className="setting">
          <label htmlFor="language">Language</label>
          <select
            id="language"
            value={settings.language}
            onChange={(e) => void update("language", e.target.value)}
          >
            <option value="auto">Automatic</option>
            {languages.map((l) => (
              <option key={l.code} value={l.code}>
                {languageName(l.code, languages)}
              </option>
            ))}
          </select>
        </div>
        <div className="setting">
          <label htmlFor="insert">Insert text with</label>
          <select
            id="insert"
            value={settings.insert}
            onChange={(e) =>
              void update("insert", e.target.value as ipc.Settings["insert"])
            }
          >
            <option value="shift-insert">Shift+Insert</option>
            <option value="ctrl-v">Ctrl+V</option>
            <option value="ctrl-shift-v">Ctrl+Shift+V</option>
            <option value="off">Off (copy only)</option>
          </select>
        </div>
      </section>
      <section className="settings-section">
        <h2>Appearance</h2>
        <div className="setting">
          <label htmlFor="theme">Theme</label>
          <select
            id="theme"
            value={settings.theme}
            onChange={(e) =>
              void update("theme", e.target.value as ipc.Settings["theme"])
            }
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
      </section>
      <section className="settings-section">
        <h2>About</h2>
        <div className="setting">
          <span>Version</span>
          <span>1.0.0</span>
        </div>
        <div className="setting">
          <span>Backend</span>
          <span>{status.backend ?? "Not loaded"}</span>
        </div>
        <div className="setting">
          <span>Data folder</span>
          <span className="path">{status.dataDir}</span>
        </div>
        <div className="setting">
          <span>Project</span>
          <button
            className="link"
            onClick={() =>
              void ipc.openProjectPage().catch((e) => setNotice(errorText(e)))
            }
          >
            Open project page
          </button>
        </div>
      </section>
    </>
  );
}
