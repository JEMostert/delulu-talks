import * as ipc from "../ipc";
import { errorText, type AppState } from "../state";
export function FirstRun({ state }: { state: AppState }) {
  const {
    settings,
    microphones,
    step,
    setStep,
    level,
    trigger,
    permission,
    setPermission,
    modelControl,
    modelReady,
    notice,
    setNotice,
    setStatus,
    update,
  } = state;
  if (!settings) return null;
  return (
    <main className="setup">
      <header className="brand">
        <img src="/delulu-talks-icon.svg" alt="" />
        <span>Delulu Talks</span>
      </header>
      <div className="setup-body">
        <div className="steps" aria-label={`Step ${step + 1} of 3`}>
          <span className={step === 0 ? "active" : ""}>
            1 <b>Microphone</b>
          </span>
          <span className={step === 1 ? "active" : ""}>
            2 <b>Typing</b>
          </span>
          <span className={step === 2 ? "active" : ""}>
            3 <b>Model</b>
          </span>
        </div>
        <div className="setup-content">
          {step === 0 && (
            <>
              <h1>Let’s hear you.</h1>
              <p>Choose a microphone and speak to check its level.</p>
              <label htmlFor="setup-mic">Microphone</label>
              <select
                id="setup-mic"
                value={settings.microphone ?? ""}
                onChange={(e) =>
                  void update("microphone", e.target.value || null)
                }
              >
                <option value="">System default</option>
                {microphones.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </select>
              <div
                className="meter"
                role="meter"
                aria-label="Microphone level"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(level * 100)}
              >
                <span style={{ width: `${Math.min(100, level * 100)}%` }} />
              </div>
              <p className="muted">Input level</p>
            </>
          )}
          {step === 1 && (
            <>
              <h1>Ready when you are.</h1>
              <p>
                Hold {trigger} to speak, then release to finish. You can also
                tap to start and tap again to stop.
              </p>
              <div className="shortcut">{trigger}</div>
              <p>Allow Delulu Talks to type into the app you’re using.</p>
              <button
                onClick={() =>
                  void ipc
                    .prepareInsert()
                    .then(setPermission)
                    .catch((e) =>
                      setPermission({ ready: false, error: errorText(e) }),
                    )
                }
              >
                Allow typing into other apps
              </button>
              {permission && (
                <p className={permission.ready ? "success" : "error"}>
                  {permission.ready
                    ? "Typing permission is ready."
                    : permission.error ||
                      "Typing permission was not granted. You can still copy transcripts."}
                </p>
              )}
            </>
          )}
          {step === 2 && (
            <>
              <h1>One last download.</h1>
              <p>
                Your speech stays on this machine. Download a model to get
                started.
              </p>
              {modelControl}
            </>
          )}
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
          <div className="setup-actions">
            {step > 0 && (
              <button onClick={() => setStep(step - 1)}>Back</button>
            )}
            <button
              className="primary"
              disabled={step === 2 && !modelReady}
              onClick={() => {
                if (step < 2) setStep(step + 1);
                else
                  void ipc
                    .finishFirstRun()
                    .then(() => ipc.getStatus())
                    .then(setStatus)
                    .catch((e) => setNotice(errorText(e)));
              }}
            >
              {step === 2 ? "Finish setup" : "Continue"}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
