import { createTranscriptCommands } from "./transcriptCommands";
import { useEffect, useState } from "react";
import {
  Check,
  LoaderCircle,
  Mic,
  Moon,
  RotateCcw,
  Square,
  Sun,
  Terminal,
  X,
} from "lucide-react";
import { bridge } from "./bridge";
import type { useWorkspace } from "./hooks/useWorkspace";
import { useTheme } from "./hooks/useTheme";
import { Sidebar } from "./components/Sidebar";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette";
import { Onboarding } from "./components/Onboarding";
import { UpdateNotice } from "./components/UpdateNotice";
import { Alert } from "./components/ui";
import { HomePage } from "./pages/HomePage";
import { LabPage } from "./pages/LabPage";
import { ModelsPage } from "./pages/ModelsPage";
import { VocabularyPage } from "./pages/VocabularyPage";
import { HistoryPage } from "./pages/HistoryPage";
import { SettingsPage } from "./pages/SettingsPage";
import type { Page } from "./types";

const pages: Record<Page, { title: string; subtitle: string }> = {
  home: { title: "Controls", subtitle: "Capture · transcribe · deliver" },
  history: {
    title: "History",
    subtitle: "Search, review and export transcripts",
  },
  vocabulary: {
    title: "Personalization",
    subtitle: "Corrections and voice shortcuts",
  },
  lab: {
    title: "Audio files",
    subtitle: "Transcribe imported recordings",
  },
  models: { title: "Models", subtitle: "Speech engine and device resources" },
  settings: {
    title: "Settings",
    subtitle: "Capture, output, runtime and application",
  },
};
function App({ workspace: w }: { workspace: ReturnType<typeof useWorkspace> }) {
  useTheme(w.settings.theme);
  const [visited, setVisited] = useState<Set<Page>>(new Set(["home"]));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [focusHistory, setFocusHistory] = useState(false);
  useEffect(() => {
    const openCommands = (event: KeyboardEvent) => {
      if (!w.ready || event.repeat || event.altKey || !(event.ctrlKey || event.metaKey) || !event.shiftKey || event.code !== "KeyP") return;
      event.preventDefault();
      if (!document.querySelector("dialog[open]")) setPaletteOpen(true);
    };
    window.addEventListener("keydown", openCommands);
    return () => window.removeEventListener("keydown", openCommands);
  }, [w.ready]);
  useEffect(() => {
    if (!focusHistory || paletteOpen || w.page !== "history") return;
    document.querySelector<HTMLInputElement>("[data-history-search]")?.focus();
    setFocusHistory(false);
  }, [focusHistory, paletteOpen, w.page]);
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
  const { actions: transcriptActions, onClearHistory } =
    createTranscriptCommands(w);
  const download = run(() => bridge.downloadUpdate());
  const install = run(() => bridge.installUpdate());
  const setup = run(() => bridge.setupModel());
  const load = run(() => bridge.loadModel());
  const unload = run(() => bridge.unloadModel());
  const setupMagic = run(() => bridge.setupMagic());
  const loadMagic = run(() => bridge.loadMagic());
  const unloadMagic = run(() => bridge.unloadMagic());
  const commands: PaletteCommand[] = [
    { id: "record", label: recording ? "Stop dictation" : "Start dictation", keywords: "record microphone capture speech", disabled: !recording && (busy || needsSetup) ? needsSetup ? "Set up or repair speech in Models first." : "Finish the current model operation first." : undefined, run: () => w.action(() => bridge.toggleDictation()) },
    { id: "history", label: "Search transcript history", keywords: "find original corrected rewritten", run: () => { w.setPage("history"); setFocusHistory(true); } },
    { id: "models", label: "Open model management", keywords: "speech rewriting runtime setup diagnostics", run: () => w.setPage("models") },
    { id: "load-speech", label: "Load speech model", detail: "Prepare R2T2 for dictation.", disabled: busy ? "Finish the current capture or model operation first." : w.status.engine === "missing" ? "Install speech in Models first." : undefined, run: () => w.action(() => bridge.loadModel()) },
    { id: "unload-speech", label: "Unload speech model", detail: "Release speech model memory.", disabled: busy ? "Finish the current capture or model operation first." : w.status.engine !== "ready" ? "The speech model is not ready to unload." : undefined, run: () => w.action(() => bridge.unloadModel()) },
    { id: "load-rewrite", label: "Load rewriting model", detail: "Prepare the selected optional Qwen 3.5 model.", disabled: busy ? "Finish the current capture or model operation first." : w.magicStatus.engine === "missing" ? "Install rewriting in Models first." : undefined, run: () => w.action(() => bridge.loadMagic()) },
    { id: "unload-rewrite", label: "Unload rewriting model", detail: "Release rewriting model memory.", disabled: busy ? "Finish the current capture or model operation first." : w.magicStatus.engine !== "ready" ? "The rewriting model is not ready to unload." : undefined, run: () => w.action(() => bridge.unloadMagic()) },
  ];
  return (
    <div className="relative grid h-[100dvh] grid-cols-[184px_minmax(0,1fr)] overflow-hidden border-t-2 border-accent max-[900px]:grid-cols-[154px_minmax(0,1fr)] max-[700px]:grid-cols-[64px_minmax(0,1fr)]">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      >
        <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_15%_0%,#1b6fd6_0%,transparent_55%),radial-gradient(90%_70%_at_85%_10%,#38d0f0_0%,transparent_50%),radial-gradient(110%_100%_at_50%_110%,#123a7a_0%,transparent_60%)] opacity-70 dark:opacity-45" />
        <div className="absolute -top-24 -left-16 size-[420px] rounded-full bg-[#6fd6ff]/35 blur-[110px] dark:bg-[#2aa6e8]/25" />
        <div className="absolute top-1/3 -right-20 size-[460px] rounded-full bg-[#2a7de8]/30 blur-[120px] dark:bg-[#1558b8]/30" />
        <div className="absolute -bottom-32 left-1/3 size-[520px] rounded-full bg-[#7c5cff]/25 blur-[130px] dark:bg-[#3b2a8c]/30" />
      </div>
      <a
        className="fixed top-2 left-2 z-[100] -translate-y-[150%] rounded-md bg-surface p-3 backdrop-blur-md focus:translate-y-0"
        href="#page-content"
      >
        Skip to content
      </a>
      <Sidebar
        page={w.page}
        onNavigate={w.setPage}
        status={w.status}
        magicStatus={w.magicStatus}
      />
      <main className="flex min-w-0 flex-col h-[calc(100dvh-2px)]">
        <header className="flex min-h-[76px] items-center justify-between gap-4 border-b border-line bg-header px-6 py-[15px] backdrop-blur-2xl max-[900px]:min-h-[70px] max-[900px]:px-4 max-[900px]:py-3">
          <div>
            <h1 className="text-[22px] tracking-[-0.6px]">
              {pages[w.page].title}
            </h1>
            <p className="mt-[3px] text-[11px] text-muted max-[700px]:hidden">
              {pages[w.page].subtitle}
            </p>
          </div>
          <div className="flex items-center gap-3.5 max-[900px]:gap-[9px]">
            <button className="icon-button" disabled={!w.ready} aria-label="Open command palette" title="Commands · Ctrl/Cmd + Shift + P" onClick={() => setPaletteOpen(true)}><Terminal /></button>
            <button
              className="icon-button theme-command max-[700px]:hidden"
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
              className={`status-chip flex items-center gap-[7px] border-0 bg-transparent py-1.5 text-[11px] ${w.status.phase === "error" ? "has-error text-danger" : "text-muted"} max-[700px]:hidden`}
              onClick={() => w.setPage("models")}
              title={w.status.message}
            >
              {speechBusy ? (
                <LoaderCircle className="spin h-[13px] w-[13px]" />
              ) : (
                <span
                  className={`h-[6px] w-[6px] inline-block rounded-full ${w.status.phase === "error" ? "bg-danger" : "bg-success"}`}
                />
              )}
              <span>
                {recording
                  ? "Listening"
                  : speechBusy
                    ? w.status.phase === "transcribing"
                      ? "Transcribing…"
                      : w.status.phase === "preparing"
                        ? "Updating setup…"
                        : "Loading & warming up…"
                    : w.status.engine === "ready"
                      ? "Ready"
                      : w.status.engine === "missing"
                        ? w.status.migrationRequired
                          ? "Update setup"
                          : "Setup needed"
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
                  ? w.status.migrationRequired
                    ? "Update dictation setup"
                    : "Set up dictation"
                  : recording
                    ? "Stop recording"
                    : "Start recording"
              }
            >
              {recording ? <Square /> : <Mic />}
              <span>
                {needsSetup
                  ? w.status.migrationRequired
                    ? "Update"
                    : "Set up"
                  : recording
                    ? "Stop"
                    : "Record"}
              </span>
            </button>
          </div>
        </header>
        {!window.delulu && (
          <div className="mx-auto mt-2.5 w-fit rounded-[99px] border border-line bg-soft px-[14px] py-[5px] text-[10px] text-muted max-[900px]:px-4">
            Browser preview · sample transcript · recording and model
            installation require the desktop app
          </div>
        )}
        {w.ready && !w.settings.onboardingComplete && (
          <Onboarding
            engine={w.status.engine}
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
        {w.status.phase === "loading" && (
          <div
            role="status"
            className="px-6 pt-3 text-sm text-muted max-[900px]:px-4"
          >
            Loading and warming up the speech model. This prepares the first
            transcription before showing Ready. Keep speech ready in Settings →
            Runtime to avoid loading it again between recordings.
          </div>
        )}
        {w.error && (
          <div className="px-6 pt-3 max-[900px]:px-4">
            <Alert onDismiss={() => w.setError(null)}>{w.error}</Alert>
          </div>
        )}
        {(w.status.phase === "error" || w.status.retryAvailable) && (
          <div className="px-6 pt-3 max-[900px]:px-4">
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
        <div
          className="page-scroll min-h-0 flex-1 overflow-y-auto px-6 pt-[18px] pb-7 max-[900px]:px-4 max-[900px]:pt-3.5 max-[900px]:pb-6"
          id="page-content"
          tabIndex={-1}
        >
          {!w.ready ? (
            <div className="empty-state mx-auto max-w-[1440px]">
              {w.startupError ? (
                <>
                  <p role="alert">{w.startupError}</p>
                  <button className="secondary-button" onClick={w.retryStartup}>
                    <RotateCcw /> Retry opening workspace
                  </button>
                </>
              ) : (
                <>
                  <LoaderCircle className="spin" />
                  <p>Opening your workspace…</p>
                </>
              )}
            </div>
          ) : (
            <>
              <div
                hidden={w.page !== "home"}
                className="mx-auto max-w-[1440px]"
              >
                <HomePage
                  settings={w.settings}
                  status={w.status}
                  magicStatus={w.magicStatus}
                  devices={w.devices}
                  busy={busy}
                  onConfigureShortcut={run(() => bridge.configureShortcut())}
                  shortcutStatus={w.shortcutStatus}
                  history={w.history}
                  captureProfile={w.captureProfile}
                  onActivateProfile={w.activateProfile}
                  saving={w.saving}
                  onNavigate={w.setPage}
                  onUpdateSettings={(patch) => {
                    void w.saveSettings(patch, null);
                  }}
                  onPasteLast={w.pasteLast}
                  onToggleRecord={onRecord}
                  {...transcriptActions}
                />
              </div>
              {(visited.has("history") || w.page === "history") && (
                <div
                  hidden={w.page !== "history"}
                  className="mx-auto max-w-[1440px]"
                >
                  <HistoryPage
                    history={w.history}
                    {...transcriptActions}
                    onClear={onClearHistory}
                  />
                </div>
              )}
              {(visited.has("lab") || w.page === "lab") && (
                <div
                  hidden={w.page !== "lab"}
                  className="mx-auto max-w-[1440px]"
                >
                  <LabPage
                    {...transcriptActions}
                    history={w.history}
                    settings={w.settings}
                    busy={busy}
                    onResult={w.receiveTranscript}
                    onToast={w.setToast}
                  />
                </div>
              )}
              {(visited.has("models") || w.page === "models") && (
                <div
                  hidden={w.page !== "models"}
                  className="mx-auto max-w-[1440px]"
                >
                  <ModelsPage
                    status={w.status}
                    magicStatus={w.magicStatus}
                    settings={w.settings}
                    busy={busy}
                    saving={w.saving}
                    onUpdateSettings={(patch) => {
                      void w.saveSettings(patch, null);
                    }}
                    onSetupMagic={setupMagic}
                    onLoadMagic={loadMagic}
                    onUnloadMagic={unloadMagic}
                    onSetup={setup}
                    onLoad={load}
                    onUnload={unload}
                  />
                </div>
              )}
              {(visited.has("vocabulary") || w.page === "vocabulary") && (
                <div
                  hidden={w.page !== "vocabulary"}
                  className="mx-auto max-w-[1440px]"
                >
                  <VocabularyPage
                    words={w.settings.customWords}
                    saving={w.saving}
                    onChange={(customWords) =>
                      w.saveSettings({ customWords }, "Rules saved")
                    }
                  />
                </div>
              )}
              {(visited.has("settings") || w.page === "settings") && (
                <div
                  hidden={w.page !== "settings"}
                  className="mx-auto max-w-[1440px]"
                >
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
                    onManagePersonalProfile={w.managePersonalProfile}
                    onActivateProfile={w.activateProfile}
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
      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
      {w.toast && (
        <div
          className="toast fixed bottom-[22px] left-[calc(50%+92px)] z-[90] flex max-w-[calc(100vw-40px)] -translate-x-1/2 items-center gap-3 rounded-[14px] border border-line-strong bg-surface px-4 py-3 text-[13px] shadow-pop backdrop-blur-xl max-[900px]:left-[calc(50%+77px)] max-[700px]:left-[calc(50%+32px)] max-[700px]:w-[calc(100vw-90px)]"
          role="status"
        >
          <Check className="text-accent" />
          <span>{w.toast}</span>
          <button
            className="flex border-0 bg-transparent p-0 text-muted"
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
