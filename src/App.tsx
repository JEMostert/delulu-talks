import { useEffect, useState } from "react";
import {
  Check,
  LoaderCircle,
  Mic,
  Moon,
  RotateCcw,
  Square,
  Sun,
  X,
} from "lucide-react";
import { bridge } from "./bridge";
import { useWorkspace } from "./hooks/useWorkspace";
import { useTheme } from "./hooks/useTheme";
import { Sidebar } from "./components/Sidebar";
import { Onboarding } from "./components/Onboarding";
import { UpdateNotice } from "./components/UpdateNotice";
import { Alert } from "./components/ui";
import { HomePage } from "./pages/HomePage";
import { LabPage } from "./pages/LabPage";
import { MagicPage } from "./pages/MagicPage";
import { ModelsPage } from "./pages/ModelsPage";
import { VocabularyPage } from "./pages/VocabularyPage";
import { HistoryPage } from "./pages/HistoryPage";
import { SettingsPage } from "./pages/SettingsPage";
import type { CustomWord, ExportFormat, Page } from "./types";

const pages: Record<Page, { title: string; subtitle: string }> = {
  home: { title: "Controls", subtitle: "Capture · transcribe · deliver" },
  history: {
    title: "History",
    subtitle: "Search, review and export transcripts",
  },
  magic: { title: "Writing", subtitle: "Rewrite text with your local model" },
  vocabulary: {
    title: "Wordbook",
    subtitle: "Corrections and voice shortcuts",
  },
  lab: {
    title: "Audio files",
    subtitle: "Transcription, alignment and subtitle export",
  },
  models: { title: "Models", subtitle: "Speech engine and device resources" },
  settings: {
    title: "Settings",
    subtitle: "Capture, output, runtime and application",
  },
};
function App() {
  const w = useWorkspace();
  useTheme(w.settings.theme);
  const [visited, setVisited] = useState<Set<Page>>(new Set(["home"]));
  useEffect(() => {
    setVisited((previous) => new Set([...previous, w.page]));
    document
      .getElementById("page-content")
      ?.scrollTo({ top: 0, behavior: "instant" });
  }, [w.page]);
  const recording = w.status.phase === "listening";
  const needsSetup =
    !recording && ["missing", "error"].includes(w.status.engine);
  const speechBusy = ["preparing", "loading", "transcribing"].includes(
    w.status.phase,
  );
  const busy =
    recording ||
    speechBusy ||
    ["preparing", "loading", "rewriting"].includes(w.magicStatus.phase);
  const run = (operation: () => Promise<unknown>, message?: string) => () => {
    void w.action(operation, message);
  };
  const onRecord = run(() => bridge.toggleDictation());
  const remember = (word: CustomWord) => {
    if (w.settings.customWords.length >= 500) {
      w.setError("Your Wordbook is full. Remove a word before adding another.");
      return Promise.resolve(false);
    }
    const existing = w.settings.customWords.find(
      (item) => item.term.toLowerCase() === word.term.toLowerCase(),
    );
    return w.saveSettings(
      {
        customWords: existing
          ? w.settings.customWords.map((item) =>
              item.id === existing.id
                ? {
                    ...item,
                    soundsLike: [
                      ...new Set([
                        ...item.soundsLike
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                        word.soundsLike,
                      ]),
                    ].join(", "),
                    enabled: true,
                  }
                : item,
            )
          : [word, ...w.settings.customWords],
      },
      "Word remembered",
    );
  };
  const transcriptActions = {
    onCopy: w.copy,
    onUpdateTranscript: w.updateTranscript,
    onRemember: remember,
    onDelete: (id: string) => {
      void w.action(async () => {
        await bridge.deleteHistory(id);
        w.setHistory((items) => items.filter((item) => item.id !== id));
      }, "Transcript deleted");
    },
    onExport: (id: string, format: ExportFormat) => {
      void w.action(async () => {
        const path = await bridge.exportTranscript(id, format);
        if (path) w.setToast("Transcript exported");
      });
    },
  };
  const download = run(() => bridge.downloadUpdate());
  const install = run(() => bridge.installUpdate());
  const setup = run(() => bridge.setupModel());
  const load = run(() => bridge.loadModel());
  const unload = run(() => bridge.unloadModel());
  const setupMagic = run(() => bridge.setupMagic());
  const loadMagic = run(() => bridge.loadMagic());
  const unloadMagic = run(() => bridge.unloadMagic());
  return (
    <div className="app-shell">
      <a className="skip-link" href="#page-content">
        Skip to content
      </a>
      <Sidebar
        page={w.page}
        onNavigate={w.setPage}
        status={w.status}
        magicStatus={w.magicStatus}
      />
      <main className="main-panel">
        <header className="commandbar">
          <div className="view-title">
            <h1>{pages[w.page].title}</h1>
            <p>{pages[w.page].subtitle}</p>
          </div>
          <div className="global-actions">
            <button
              className="icon-button theme-command"
              aria-label="Switch color theme"
              title="Switch light / dark theme"
              onClick={() =>
                void w.saveSettings(
                  {
                    theme:
                      document.documentElement.dataset.theme === "dark"
                        ? "light"
                        : "dark",
                  },
                  null,
                )
              }
            >
              {w.settings.theme === "light" ? <Moon /> : <Sun />}
            </button>
            <button
              className={`status-chip ${w.status.phase === "error" ? "has-error" : ""}`}
              onClick={() => w.setPage("models")}
              title={w.status.message}
            >
              {speechBusy ? (
                <LoaderCircle className="spin" />
              ) : (
                <span className="status-dot" />
              )}
              <span>
                {recording
                  ? "Listening"
                  : speechBusy
                    ? w.status.phase === "transcribing"
                      ? "Transcribing…"
                      : "Loading engine…"
                    : w.status.engine === "ready"
                      ? "Ready"
                      : w.status.engine === "missing"
                        ? "Setup needed"
                        : w.status.engine === "error"
                          ? "Needs attention"
                          : "Loads on demand"}
              </span>
            </button>
            {recording && (
              <button
                className="icon-button"
                aria-label="Cancel recording"
                onClick={run(() => bridge.cancelDictation())}
              >
                <X />
              </button>
            )}
            <button
              className={`record-command ${recording ? "recording" : ""}`}
              disabled={!w.ready || speechBusy || (!recording && busy)}
              onClick={needsSetup ? () => w.setPage("models") : onRecord}
              aria-label={
                needsSetup
                  ? "Set up dictation"
                  : recording
                    ? "Stop recording"
                    : "Start recording"
              }
            >
              {recording ? <Square /> : <Mic />}
              <span>
                {needsSetup ? "Set up" : recording ? "Stop" : "Record"}
              </span>
            </button>
          </div>
        </header>
        {!window.delulu && (
          <div className="preview-notice">
            Browser preview · sample transcript · recording and model
            installation require the desktop app
          </div>
        )}
        {w.ready && !w.settings.onboardingComplete && (
          <Onboarding
            settings={w.settings}
            saving={w.saving}
            onFinish={w.finishOnboarding}
          />
        )}
        <UpdateNotice
          status={w.updateStatus}
          busy={busy}
          onDownload={download}
          onInstall={install}
        />
        {w.error && (
          <div className="global-alert">
            <Alert onDismiss={() => w.setError(null)}>{w.error}</Alert>
          </div>
        )}
        {(w.status.phase === "error" || w.status.retryAvailable) && (
          <div className="global-alert">
            <Alert
              action={
                w.status.retryAvailable ? (
                  <div className="panel-actions">
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={run(() => bridge.retryRecording())}
                    >
                      <RotateCcw />
                      Retry recording
                    </button>
                    <button
                      className="tool-button"
                      disabled={busy}
                      onClick={run(() => bridge.discardFailedRecording())}
                    >
                      Discard
                    </button>
                  </div>
                ) : (
                  <button
                    className="secondary-button"
                    onClick={() => w.setPage("models")}
                  >
                    Open models
                  </button>
                )
              }
            >
              {w.status.retryAvailable && w.status.phase !== "error"
                ? "A previous recording is available to retry."
                : w.status.message}
              {w.status.retryAvailable && (
                <p className="caption">
                  Audio is held in memory for retry during this session.
                </p>
              )}
            </Alert>
          </div>
        )}
        <div className="page-scroll" id="page-content" tabIndex={-1}>
          {!w.ready ? (
            <div className="empty-state">
              <LoaderCircle className="spin" />
              <p>Opening your workspace…</p>
            </div>
          ) : (
            <>
              <div hidden={w.page !== "home"}>
                <HomePage
                  settings={w.settings}
                  status={w.status}
                  magicStatus={w.magicStatus}
                  devices={w.devices}
                  busy={busy}
                  onConfigureShortcut={run(() => bridge.configureShortcut())}
                  shortcutStatus={w.shortcutStatus}
                  history={w.history}
                  saving={w.saving}
                  onNavigate={w.setPage}
                  onUpdateSettings={(patch) => {
                    void w.saveSettings(patch, null);
                  }}
                  onPasteLast={w.pasteLast}
                  {...transcriptActions}
                />
              </div>
              {(visited.has("history") || w.page === "history") && (
                <div hidden={w.page !== "history"}>
                  <HistoryPage
                    history={w.history}
                    {...transcriptActions}
                    onClear={run(async () => {
                      await bridge.clearHistory();
                      w.setHistory([]);
                    }, "History cleared")}
                  />
                </div>
              )}
              {(visited.has("magic") || w.page === "magic") && (
                <div hidden={w.page !== "magic"}>
                  <MagicPage
                    settings={w.settings}
                    status={w.magicStatus}
                    history={w.history}
                    saving={
                      w.saving || (busy && w.magicStatus.phase === "idle")
                    }
                    onUpdateSettings={(patch) => {
                      void w.saveSettings(patch);
                    }}
                    onSetup={setupMagic}
                    onLoad={loadMagic}
                    onUnload={unloadMagic}
                    onRewrite={(request) => bridge.rewriteMagic(request)}
                    onCopy={w.copy}
                    onToast={w.setToast}
                  />
                </div>
              )}
              {(visited.has("lab") || w.page === "lab") && (
                <div hidden={w.page !== "lab"}>
                  <LabPage
                    settings={w.settings}
                    busy={busy}
                    onResult={w.receiveTranscript}
                    onToast={w.setToast}
                  />
                </div>
              )}
              {(visited.has("models") || w.page === "models") && (
                <div hidden={w.page !== "models"}>
                  <ModelsPage
                    selected={w.settings.model}
                    status={w.status}
                    saving={w.saving || busy}
                    licenseAccepted={w.settings.modelLicenseAccepted}
                    onSelect={(model) => {
                      void w.saveSettings({ model });
                    }}
                    onSetup={setup}
                    onLoad={load}
                    onUnload={unload}
                    onAcceptLicense={() =>
                      w.saveSettings(
                        { modelLicenseAccepted: true },
                        "License accepted",
                      )
                    }
                  />
                </div>
              )}
              {(visited.has("vocabulary") || w.page === "vocabulary") && (
                <div hidden={w.page !== "vocabulary"}>
                  <VocabularyPage
                    words={w.settings.customWords}
                    saving={w.saving}
                    onChange={(customWords) =>
                      w.saveSettings({ customWords }, "Wordbook saved")
                    }
                  />
                </div>
              )}
              {(visited.has("settings") || w.page === "settings") && (
                <div hidden={w.page !== "settings"}>
                  <SettingsPage
                    settings={w.settings}
                    devices={w.devices}
                    capabilities={w.capabilities}
                    shortcutStatus={w.shortcutStatus}
                    updateStatus={w.updateStatus}
                    status={w.status}
                    magicStatus={w.magicStatus}
                    saving={w.saving}
                    onSave={w.saveSettings}
                    onConfigureShortcut={run(() => bridge.configureShortcut())}
                    onAuthorizePaste={run(
                      () => bridge.authorizePaste(),
                      "Paste permission saved",
                    )}
                    onTestPaste={() => {
                      w.setToast(
                        "Focus another text field — pasting in 3 seconds…",
                      );
                      void w.action(() => bridge.testPaste(), "Test pasted");
                    }}
                    onCheckForUpdates={run(() => bridge.checkForUpdates())}
                    onDownloadUpdate={download}
                    onInstallUpdate={install}
                    onSetup={setup}
                    onLoad={load}
                    onUnload={unload}
                    onSetupMagic={setupMagic}
                    onLoadMagic={loadMagic}
                    onUnloadMagic={unloadMagic}
                    onReset={run(
                      () => bridge.resetPythonEnvironment(),
                      "Runtime removed",
                    )}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </main>
      {w.toast && (
        <div className="toast" role="status">
          <Check />
          <span>{w.toast}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => w.setToast(null)}
          >
            <X />
          </button>
        </div>
      )}
    </div>
  );
}
export default App;
