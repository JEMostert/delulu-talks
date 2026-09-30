import { deliveredText, transcriptText, transcriptSourceRevision } from "./transcriptText";
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
import { profilePaletteCommands } from "./profilePaletteCommands";
import { effectiveProfileSettings } from "./activePersonalProfile";
import { Onboarding } from "./components/Onboarding";
import { PasteLastNotice } from "./components/PasteLastNotice";
import { ServiceRecovery } from "./components/ServiceRecovery";
import { UpdateNotice } from "./components/UpdateNotice";
import { OperationResumeNotice } from "./components/OperationResumeNotice";
import { RewriteDialog } from "./components/RewriteDialog";
import { PasteRecoveryNotice } from "./components/PasteRecoveryNotice";
import { Alert } from "./components/ui";
import { HomePage } from "./pages/HomePage";
import { LabPage } from "./pages/LabPage";
import { TechnicalPage } from "./pages/TechnicalPage";
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
  models: { title: "Models", subtitle: "Speech and rewrite models, runtimes and backends" },
  technical: { title: "Technical text", subtitle: "Literal editing · undo · explicit copy" },
  settings: {
    title: "Settings",
    subtitle: "Capture, output, runtime and application",
  },
};
function App({ workspace: w }: { workspace: ReturnType<typeof useWorkspace> }) {
  useTheme(w.settings.theme);
  const [modelTarget, setModelTarget] = useState<"decode" | "diagnostics" | null>(null);
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
    w.operations.hideRewrite();
  }, [w.page]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey ||
          !(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key !== "m" && key !== "d") return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")) return;
      if (document.querySelector("[role='dialog'][aria-modal='true']")) return;
      event.preventDefault();
      w.setPage("models");
      setModelTarget(key === "m" ? "decode" : "diagnostics");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [w.setPage]);
  useEffect(() => {
    if (!w.ready || w.page !== "models" || !modelTarget) return;
    const element = document.getElementById(`models-${modelTarget}`);
    element?.focus();
    element?.scrollIntoView({ block: "start", behavior: "instant" });
    if (modelTarget === "diagnostics")
      document.getElementById("runtime-diagnostics-refresh")?.click();
    setModelTarget(null);
  }, [modelTarget, w.page, w.ready]);
  const recording = w.status.phase === "listening" || w.status.phase === "paused";
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
  const { actions: baseTranscriptActions, onClearHistory } =
    createTranscriptCommands(w);
  const transcriptActions = {
    ...baseTranscriptActions,
    onOpenRewrite: (record: Parameters<typeof w.operations.openRewrite>[0]) => w.operations.openRewrite(record, w.page),
  };
  const rewrite = w.operations.rewriteOperation;
  const rewriteRecord = rewrite ? w.history.find((record) => record.id === rewrite.transcriptId) : undefined;
  const download = run(() => bridge.downloadUpdate());
  const install = run(() => bridge.installUpdate());
  const setup = run(() => bridge.setupModel());
  const load = run(() => bridge.loadModel());
  const unload = run(() => bridge.unloadModel());
  const setupMagic = run(() => bridge.setupMagic());
  const loadMagic = run(() => bridge.loadMagic());
  const unloadMagic = run(() => bridge.unloadMagic());
  const commands: PaletteCommand[] = [
    ...profilePaletteCommands(w.settings, (profile) => w.activateProfile({ action: "activate", id: profile.id, expectedProfile: profile, expectedCurrentSettings: effectiveProfileSettings(w.settings) }), {
      disabled: busy || w.saving ? "Finish the current capture, model operation, or settings save before switching profiles." : undefined,
      activeId: w.settings.activePersonalProfile?.id,
      global: () => w.activateProfile({ action: "global", expectedCurrentSettings: effectiveProfileSettings(w.settings) }),
    }),
    { id: "record", label: recording ? "Stop dictation" : "Start dictation", keywords: "record microphone capture speech", disabled: !recording && (busy || needsSetup) ? needsSetup ? "Set up or repair speech in Models first." : "Finish the current model operation first." : undefined, run: () => w.action(() => bridge.toggleDictation()) },
    { id: "history", label: "Search transcript history", keywords: "find original corrected rewritten", run: () => { w.setPage("history"); setFocusHistory(true); } },
    { id: "models", label: "Open model management", keywords: "speech rewriting runtime setup diagnostics", run: () => w.setPage("models") },
    { id: "load-speech", label: "Load speech model", detail: "Prepare R2T2 for dictation.", disabled: busy ? "Finish the current capture or model operation first." : w.status.engine === "missing" ? "Install speech in Models first." : undefined, run: () => { w.setPage("models"); load(); } },
    { id: "unload-speech", label: "Unload speech model", detail: "Release speech model memory.", disabled: busy ? "Finish the current capture or model operation first." : w.status.engine !== "ready" ? "The speech model is not ready to unload." : undefined, run: () => { w.setPage("models"); unload(); } },
    { id: "load-rewrite", label: "Load rewriting model", detail: "Prepare the selected optional Qwen 3.5 model.", disabled: busy ? "Finish the current capture or model operation first." : w.magicStatus.engine === "missing" ? "Install rewriting in Models first." : undefined, run: () => { w.setPage("models"); loadMagic(); } },
    { id: "unload-rewrite", label: "Unload rewriting model", detail: "Release rewriting model memory.", disabled: busy ? "Finish the current capture or model operation first." : w.magicStatus.engine !== "ready" ? "The rewriting model is not ready to unload." : undefined, run: () => { w.setPage("models"); unloadMagic(); } },
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
                  ? w.status.phase === "paused" ? "Paused" : "Listening"
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
            {recording && <button className="secondary-button" onClick={run(() => w.status.phase === "paused" ? bridge.resumeDictation() : bridge.pauseDictation())}>
              {w.status.phase === "paused" ? "Resume" : "Pause"}
            </button>}
            {recording && (
              <button
                className="icon-button"
                aria-label="Cancel recording"
                onClick={run(() => bridge.cancelDictation())}
              >
                <X />
              </button>
            )}
            {(w.page !== "home" || recording) && (
              <button
                id={recording ? "recording-stop-control" : undefined}
                className={`record-command ${recording ? "recording" : ""}`}
                disabled={recording ? false : !w.ready || speechBusy || busy}
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
                <span style={recording ? { display: "inline" } : undefined}>
                  {needsSetup
                    ? w.status.migrationRequired
                      ? "Update"
                      : "Set up"
                    : recording
                      ? "Stop"
                      : "Record"}
                </span>
              </button>
            )}
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
        {w.ready && <ServiceRecovery recovery={w.serviceRecovery} />}
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
        <OperationResumeNotice operations={w.operations} onImport={() => w.setPage("lab")} />
        {w.status.captureInputNotice && (
          <div className="px-6 pt-3 max-[900px]:px-4">
            <div
              role="status"
              aria-live="polite"
              className="rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-muted"
            >
              {w.status.captureInputNotice}
            </div>
          </div>
        )}
        <PasteRecoveryNotice onCopied={() => w.setToast("Copied to clipboard — paste manually")} />
        {w.status.phase === "paused" && <div role="status" className="px-6 pt-3 text-sm text-muted">Paused. Audio stays in this session; the microphone remains open. Resume to keep recording, or Stop to transcribe the retained audio.</div>}
        {w.error && (
          <div className="px-6 pt-3 max-[900px]:px-4">
            <Alert onDismiss={() => w.setError(null)}>{w.error}</Alert>
          </div>
        )}
        {(() => {
          const retryAudio = w.status.retryAudio;
          const retrying = retryAudio?.phase === "retrying";
          const retained = retryAudio
            ? retryAudio.byteLength > 0 && !retryAudio.discarded
            : !!w.status.retryAvailable;
          const available = retryAudio
            ? retryAudio.phase === "available" && retained
            : !!w.status.retryAvailable;
          if (
            w.status.phase !== "error" &&
            !w.status.retryAvailable &&
            !available &&
            !retrying
          )
            return null;
          return (
            <div className="px-6 pt-3 max-[900px]:px-4">
              <Alert
                action={
                  available || retrying ? (
                    retained ? (
                      <div className="panel-actions">
                        <button
                          className="secondary-button"
                          disabled={busy || retrying}
                          onClick={run(() => bridge.retryRecording())}
                        >
                          <RotateCcw />
                          Retry transcription
                        </button>
                        <button
                          className="tool-button"
                          disabled={!retryAudio && busy}
                          onClick={run(() => bridge.discardFailedRecording())}
                        >
                          Discard retained audio
                        </button>
                      </div>
                    ) : undefined
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
                {retrying
                  ? "Retrying transcription."
                  : available && w.status.phase !== "error"
                    ? "A previous recording is available to retry."
                    : w.status.message}
                {(available || retrying) && (
                  <p className="caption">
                    {retained ? (
                      <>
                        Audio is available only during this session.
                        {retryAudio && (
                          <>
                            {retryAudio.durationMs !== null &&
                              ` Duration: ${(retryAudio.durationMs / 1000).toFixed(1)} seconds.`}
                            {` Size: ${
                              retryAudio.byteLength >= 1024 * 1024
                                ? `${(retryAudio.byteLength / (1024 * 1024)).toFixed(1)} MB`
                                : `${Math.ceil(retryAudio.byteLength / 1024)} KB`
                            }.`}
                          </>
                        )}
                        {retrying &&
                          " Discarding this backup will not interrupt the current transcription."}
                      </>
                    ) : (
                      "Audio has been released. The current transcription continues."
                    )}
                  </p>
                )}
              </Alert>
            </div>
          );
        })()}
        <div
          className="page-scroll min-h-0 flex-1 overflow-y-auto px-6 pt-[18px] pb-7 max-[900px]:px-4 max-[900px]:pt-3.5 max-[900px]:pb-6"
          id="page-content"
          role="region"
          aria-label={pages[w.page].title}
          tabIndex={-1}
        >
          <PasteLastNotice
            status={w.pasteLastStatus}
            onCancel={w.cancelPasteLast}
          />
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
                  capabilities={w.capabilities}
                  busy={busy}
                  onConfigureShortcut={run(() => bridge.configureShortcut())}
                  shortcutStatus={w.shortcutStatus}
                  history={w.history}
                  captureDiagnostics={w.captureDiagnostics}
                  captureProfile={w.captureProfile}
                  onActivateProfile={w.activateProfile}
                  saving={w.saving}
                  onNavigate={w.setPage}
                  onUpdateSettings={(patch) => {
                    void w.saveSettings(patch, null);
                  }}
                  onPasteLast={w.pasteLast}
                  onToggleRecord={() =>
                    w.action(() => bridge.toggleDictation())
                  }
                  pasteLastBusy={["pending", "delivering"].includes(
                    w.pasteLastStatus.phase,
                  )}
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
                    view={w.historyView}
                    onViewChange={w.setHistoryView}
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
                    busy={busy}
                    operation={w.operations.importOperation}
                    onChoose={w.operations.chooseImport}
                    onRun={() => w.operations.runImport(busy)}
                    onClearError={w.operations.clearImportError}
                  />
                </div>
              )}
              {(visited.has("technical") || w.page === "technical") && (
                <div hidden={w.page !== "technical"} className="mx-auto max-w-[1440px]">
                  <TechnicalPage history={w.history} settings={w.settings} busy={busy || w.saving}
                    onUpdateSettings={(patch) => w.saveSettings(patch, null)}
                    rewriteStatus={w.magicStatus} onRewriteSetup={() => w.setPage("models")} />
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
                      void w.action(() => bridge.testPaste(), "Paste test shortcut sent — check your destination");
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
      {rewrite && (
        <RewriteDialog
          key={rewrite.key}
          contextLabel={rewrite.label}
          text={rewriteRecord ? transcriptText(rewriteRecord) : rewrite.source}
          baseline={rewriteRecord ? deliveredText(rewriteRecord) : rewrite.baseline}
          sourceRevision={rewriteRecord ? transcriptSourceRevision(rewriteRecord) : rewrite.sourceRevision}
          sourceLanguage={rewrite.sourceLanguage}
          status={w.magicStatus}
          visible={rewrite.visible}
          onBackground={w.operations.hideRewrite}
          onOperationState={(phase) => w.operations.rewriteState(rewrite.key, phase)}
          onClose={() => w.operations.closeRewrite(rewrite.key)}
          onSetup={() => w.setPage("models")}
          onRewrite={(request) => w.operations.runRewrite(rewrite.key, request)}
          onApply={(result, source, sourceRevision) => w.operations.applyRewrite(rewrite.key, () =>
            baseTranscriptActions.onSetRewrite!(rewrite.transcriptId, result, source, sourceRevision))}
        />
      )}
      {paletteOpen && <CommandPalette commands={commands} actionError={w.error} onClose={() => setPaletteOpen(false)} />}
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
