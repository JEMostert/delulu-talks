import * as ipc from "../ipc";
import { languageName } from "../helpers";
import { Keys, Row, Segmented, Select, Switch } from "../components/Controls";
import { Icon } from "../components/Icon";
import { errorText, type AppState } from "../state";

type Props = { state: AppState };

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
              <span>Change it in GNOME Settings › Apps › Delulu Talks.</span>
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
  const { settings, update, modelControl, languages } = state;
  if (!settings) return null;
  return (
    <div className="group">
      <Row
        label="Model"
        htmlFor="model"
        help="Runs on your graphics card. Nothing leaves this computer."
        stack
      >
        {modelControl}
      </Row>
      <Row
        label="Language"
        htmlFor="language"
        help="Automatic follows whatever you speak."
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
        <span className="value tabular">1.0.0</span>
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
