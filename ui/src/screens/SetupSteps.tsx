import * as ipc from "../ipc";
import { Keys, Select } from "../components/Controls";
import { Icon } from "../components/Icon";
import { errorText, type AppState } from "../state";

type Props = { state: AppState };

export function MicrophoneStep({ state }: Props) {
  const { settings, microphones, level, update } = state;
  if (!settings) return null;
  const percent = Math.round(Math.min(1, level) * 100);
  return (
    <>
      <h1>Let’s hear you</h1>
      <p className="lead">
        Pick a microphone and say something. The pearl lights up when it hears
        you.
      </p>
      <div className="field">
        <label htmlFor="setup-mic">Microphone</label>
        <Select
          id="setup-mic"
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
      </div>
      <div className="field">
        <span className="field-label" id="level-label">
          Input level
        </span>
        <div
          className="bar bar-level"
          role="meter"
          aria-labelledby="level-label"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={{ transform: `scaleX(${percent / 100})` }} />
        </div>
      </div>
    </>
  );
}

export function TypingStep({ state }: Props) {
  const { status, permission, setPermission } = state;
  return (
    <>
      <h1>Your talk key</h1>
      <p className="lead">
        Hold it in any app, talk, and let go. Your words are typed where your
        cursor is. A quick tap starts, another tap stops.
      </p>
      <div className="setup-keys">
        <Keys trigger={status?.hotkey.trigger} large />
      </div>
      <p className="muted">You can change it later in Settings.</p>
      <div className="permission">
        <div>
          <p className="permission-title">Typing into other apps</p>
          <p className="muted">
            Your desktop asks once whether Delulu Talks may type for you.
          </p>
        </div>
        {permission?.ready ? (
          <span className="model-ready">
            <Icon name="check" size={16} />
            Allowed
          </span>
        ) : (
          <button
            type="button"
            className="button"
            onClick={() =>
              void ipc
                .prepareInsert()
                .then(setPermission)
                .catch((e) =>
                  setPermission({ ready: false, error: errorText(e) }),
                )
            }
          >
            Allow typing
          </button>
        )}
      </div>
      {permission && !permission.ready && (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={16} />
          {permission.error ||
            "Not allowed. Transcripts will be copied so you can paste them."}
        </p>
      )}
    </>
  );
}

export function ModelStep({ state }: Props) {
  return (
    <>
      <h1>One download</h1>
      <p className="lead">
        Speech recognition runs on this computer, so it needs a model. After
        this, nothing you say leaves your machine.
      </p>
      <p className="muted">
        Text cleanup (5.2 GB) downloads in the background afterwards. You can
        turn it off in Settings.
      </p>
      <div className="field">
        <label htmlFor="model">Model</label>
        {state.modelControl}
      </div>
    </>
  );
}
