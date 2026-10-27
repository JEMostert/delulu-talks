import { useCallback, useEffect, useState } from "react";
import * as ipc from "./ipc";
import {
  formatDate,
  formatMs,
  insertMessage,
  languageName,
  settingsPatch,
} from "./helpers";
import "./style.css";

type Page = "Home" | "History" | "Settings";
const phases: Record<ipc.Phase, string> = {
  needsSetup: "Getting ready",
  loadingModel: "Preparing",
  idle: "Ready to listen",
  recording: "Listening",
  transcribing: "Turning speech into text",
  error: "Needs attention",
};
const errorText = (error: unknown) => String(error);

export default function App() {
  const [status, setStatus] = useState<ipc.Status>();
  const [settings, setSettings] = useState<ipc.Settings>();
  const [microphones, setMicrophones] = useState<ipc.InputDevice[]>([]);
  const [languages, setLanguages] = useState<ipc.Language[]>([]);
  const [models, setModels] = useState<ipc.ModelStatus[]>([]);
  const [history, setHistory] = useState<ipc.HistoryEntry[]>([]);
  const [page, setPage] = useState<Page>("Home");
  const [query, setQuery] = useState("");
  const [step, setStep] = useState(0);
  const [level, setLevel] = useState(0);
  const [progress, setProgress] = useState<ipc.ModelDownload>();
  const [downloading, setDownloading] = useState(false);
  const [notice, setNotice] = useState("");
  const [recovery, setRecovery] = useState<ipc.TranscriptEvent>();
  const [permission, setPermission] = useState<ipc.InsertStatus>();
  const [confirmClear, setConfirmClear] = useState(false);
  const [hotkeyHint, setHotkeyHint] = useState(false);
  const refreshModels = useCallback(
    () =>
      ipc
        .listModels()
        .then(setModels)
        .catch((e) => setNotice(errorText(e))),
    [],
  );
  const refreshHistory = useCallback(
    () =>
      ipc
        .getHistory(query || null, page === "Home" ? 5 : 1000)
        .then(setHistory)
        .catch((e) => setNotice(errorText(e))),
    [query, page],
  );
  useEffect(() => {
    let active = true;
    const unlisteners: (() => void)[] = [];
    const subscribe = (promise: Promise<() => void>) =>
      promise
        .then((fn) => {
          if (active) unlisteners.push(fn);
          else fn();
        })
        .catch((e) => setNotice(errorText(e)));
    Promise.all([
      ipc.getStatus(),
      ipc.getSettings(),
      ipc.listMicrophones(),
      ipc.listLanguages(),
      ipc.listModels(),
    ])
      .then(([s, config, inputs, langs, available]) => {
        if (active) {
          setStatus(s);
          setSettings(config);
          setMicrophones(inputs);
          setLanguages(langs);
          setModels(available);
        }
      })
      .catch((e) => setNotice(errorText(e)));
    subscribe(ipc.onStatus(setStatus));
    subscribe(ipc.onMicLevel(setLevel));
    subscribe(
      ipc.onTranscript((value) => {
        setRecovery(value);
        setNotice(insertMessage(value.insert));
        ipc
          .getHistory(null, 5)
          .then(setHistory)
          .catch((e) => setNotice(errorText(e)));
      }),
    );
    subscribe(
      ipc.onModelDownload((value) => {
        setProgress(value);
        if (value.finished || value.error) {
          setDownloading(false);
          void refreshModels();
        }
      }),
    );
    return () => {
      active = false;
      unlisteners.forEach((fn) => fn());
    };
  }, [refreshModels]);
  useEffect(() => {
    let active = true;
    ipc
      .getHistory(query || null, page === "Home" ? 5 : 1000)
      .then((entries) => {
        if (active) setHistory(entries);
      })
      .catch((e) => {
        if (active) setNotice(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [query, page]);
  useEffect(() => {
    if (!settings) return;
    document.documentElement.dataset.theme = settings.theme;
  }, [settings?.theme]);
  useEffect(() => {
    if (status?.phase !== "needsSetup" || step !== 0) return;
    let active = true;
    ipc.startMicTest().catch((e) => {
      if (active) setNotice(errorText(e));
    });
    return () => {
      active = false;
      void ipc.stopMicTest().catch(() => {});
    };
  }, [status?.phase, step, settings?.microphone]);
  async function update<K extends keyof ipc.Settings>(
    key: K,
    value: ipc.Settings[K],
  ) {
    if (!settings) return;
    try {
      setSettings(await ipc.setSettings(settingsPatch(settings, key, value)));
    } catch (e) {
      setNotice(errorText(e));
    }
  }
  async function download() {
    if (!settings) return;
    setProgress(undefined);
    setDownloading(true);
    try {
      await ipc.downloadModel(settings.model);
    } catch (e) {
      setDownloading(false);
      setNotice(errorText(e));
      setProgress({
        id: settings.model,
        doneBytes: 0,
        totalBytes: 0,
        finished: false,
        error: errorText(e),
      });
    }
  }
  async function cancel() {
    try {
      await ipc.cancelDownload();
      setDownloading(false);
      setProgress(undefined);
    } catch (e) {
      setNotice(errorText(e));
    }
  }
  async function copy(text: string) {
    try {
      await ipc.copyText(text);
      setNotice("Copied to clipboard");
    } catch (e) {
      setNotice(`Could not copy: ${errorText(e)}`);
    }
  }
  async function insert(entry: ipc.HistoryEntry) {
    try {
      const result = await ipc.reinsert(entry.id);
      setRecovery({ entry, insert: result });
      setNotice(insertMessage(result));
    } catch (e) {
      setRecovery({ entry, insert: { kind: "failed", reason: errorText(e) } });
      setNotice(`Could not insert: ${errorText(e)}`);
    }
  }
  const selectedModel = models.find((m) => m.id === settings?.model);
  const modelReady =
    selectedModel?.downloaded ||
    (progress != null &&
      progress.id === settings?.model &&
      progress.finished &&
      !progress.error);
  const trigger = status?.hotkey.trigger ?? "Not assigned";
  const modelControl = (
    <>
      <label htmlFor="model">Model</label>
      <select
        id="model"
        value={settings?.model ?? ""}
        disabled={downloading}
        onChange={(e) => void update("model", e.target.value)}
      >
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      <p className="muted">
        {selectedModel?.downloaded ? "Downloaded" : "Download required"}
        {selectedModel
          ? ` · ${Math.round(selectedModel.bytes / 1000000)} MB`
          : ""}
      </p>
      {downloading && (
        <>
          <progress
            max={progress?.totalBytes || 100}
            value={progress?.doneBytes || 0}
          />
          <p className="muted">
            Downloading{" "}
            {progress?.totalBytes
              ? `${Math.round((progress.doneBytes / progress.totalBytes) * 100)}%`
              : "…"}
          </p>
          <button onClick={() => void cancel()}>Cancel download</button>
        </>
      )}
      {progress?.error && <p className="error">{progress.error}</p>}
      {!downloading && !modelReady && (
        <button onClick={() => void download()}>
          {progress?.error ? "Retry download" : "Download model"}
        </button>
      )}
    </>
  );
  if (!status || !settings)
    return (
      <main className="loading">
        <img src="/delulu-talks-icon.svg" alt="" />
        <p>{notice || "Starting Delulu Talks…"}</p>
      </main>
    );
  if (status.phase === "needsSetup")
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
  return (
    <div className="app">
      <aside>
        <div className="brand">
          <img src="/delulu-talks-icon.svg" alt="" />
          <span>Delulu Talks</span>
        </div>
        <nav aria-label="Main navigation">
          {(["Home", "History", "Settings"] as Page[]).map((item) => (
            <button
              key={item}
              className={page === item ? "selected" : ""}
              onClick={() => {
                setPage(item);
                setQuery("");
              }}
            >
              {item}
            </button>
          ))}
        </nav>
        <p className="aside-note">Your voice, on your machine.</p>
      </aside>
      <main className="content">
        {notice && (
          <div className="notice" role="status">
            {notice}
            <button aria-label="Dismiss message" onClick={() => setNotice("")}>
              ×
            </button>
          </div>
        )}
        {page === "Home" && (
          <>
            <div className="page-heading">
              <h1>Home</h1>
              <p>Your space to speak freely.</p>
            </div>
            <section className={`status status-${status.phase}`}>
              <div className="status-orb" aria-hidden="true">
                <span />
              </div>
              <div>
                <p className="status-label">Dictation</p>
                <h2>{phases[status.phase]}</h2>
                <p>
                  {status.message ||
                    (status.phase === "idle"
                      ? `Hold ${trigger} to speak, or tap to start and stop.`
                      : status.hotkey.error || "")}
                </p>
              </div>
            </section>
            {recovery?.insert.kind === "failed" && (
              <section className="recovery">
                <h2>Recover transcript</h2>
                <p>{recovery.entry.text}</p>
                <p className="error">{insertMessage(recovery.insert)}</p>
                <button onClick={() => void copy(recovery.entry.text)}>
                  Copy
                </button>
              </section>
            )}
            <div className="section-title">
              <h2>Recent transcripts</h2>
              <button
                className="link"
                onClick={() => {
                  setQuery("");
                  setPage("History");
                }}
              >
                View history
              </button>
            </div>
            {history.length === 0 ? (
              <p className="empty">Your recent transcripts will appear here.</p>
            ) : (
              history.map((entry) => (
                <Transcript
                  key={entry.id}
                  entry={entry}
                  languages={languages}
                  onCopy={copy}
                  onInsert={insert}
                />
              ))
            )}
          </>
        )}
        {page === "History" && (
          <>
            <div className="page-heading">
              <h1>History</h1>
              <p>Find and manage your past transcripts.</p>
            </div>
            <div className="history-tools">
              <label className="search">
                <span>Search transcripts</span>
                <input
                  type="search"
                  placeholder="Search transcripts"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              {history.length > 0 && (
                <button onClick={() => setConfirmClear(true)}>
                  Clear history
                </button>
              )}
            </div>
            {confirmClear && (
              <div className="confirm" role="alert">
                <p>Delete all transcripts? This cannot be undone.</p>
                <button onClick={() => setConfirmClear(false)}>Cancel</button>
                <button
                  className="danger"
                  onClick={() =>
                    void ipc
                      .clearHistory()
                      .then(() => {
                        setConfirmClear(false);
                        return refreshHistory();
                      })
                      .catch((e) => setNotice(errorText(e)))
                  }
                >
                  Delete all
                </button>
              </div>
            )}
            {history.length === 0 ? (
              <p className="empty">
                {query
                  ? "No transcripts match your search."
                  : "No transcripts yet."}
              </p>
            ) : (
              history.map((entry) => (
                <Transcript
                  key={entry.id}
                  entry={entry}
                  languages={languages}
                  onCopy={copy}
                  onInsert={insert}
                  onDelete={() =>
                    void ipc
                      .deleteHistory(entry.id)
                      .then(refreshHistory)
                      .catch((e) => setNotice(errorText(e)))
                  }
                />
              ))
            )}
          </>
        )}
        {page === "Settings" && (
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
                  onChange={(e) =>
                    void update("startAtLogin", e.target.checked)
                  }
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
                    void update(
                      "insert",
                      e.target.value as ipc.Settings["insert"],
                    )
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
                    void update(
                      "theme",
                      e.target.value as ipc.Settings["theme"],
                    )
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
                <span className="path">
                  $XDG_DATA_HOME/delulu-talks
                  <br />
                  <small>Default: ~/.local/share/delulu-talks</small>
                </span>
              </div>
              <div className="setting">
                <span>Project</span>
                <button
                  className="link"
                  onClick={() =>
                    void ipc
                      .openProjectPage()
                      .catch((e) => setNotice(errorText(e)))
                  }
                >
                  Open project page
                </button>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
function Transcript({
  entry,
  languages,
  onCopy,
  onInsert,
  onDelete,
}: {
  entry: ipc.HistoryEntry;
  languages: ipc.Language[];
  onCopy: (text: string) => void;
  onInsert: (entry: ipc.HistoryEntry) => void;
  onDelete?: () => void;
}) {
  return (
    <article className="transcript">
      <p className="transcript-text">{entry.text}</p>
      <div className="transcript-bottom">
        <span className="muted">
          {formatDate(entry.createdAt)} ·{" "}
          {languageName(entry.language, languages)} · {formatMs(entry.totalMs)}
        </span>
        <div className="transcript-actions">
          <button onClick={() => onCopy(entry.text)}>Copy</button>
          <button onClick={() => onInsert(entry)}>Insert again</button>
          {onDelete && <button onClick={onDelete}>Delete</button>}
        </div>
      </div>
    </article>
  );
}
