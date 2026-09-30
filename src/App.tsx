import { SelectedTextWorkflow } from "./components/SelectedTextWorkflow";
import {
  deliveredText,
  transcriptText,
  transcriptSourceRevision,
} from "./transcriptText";
import { createTranscriptCommands } from "./transcriptCommands";
import { Activity, lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  AudioLines,
  Check,
  Clock3,
  Code2,
  Cpu,
  Home,
  LoaderCircle,
  RotateCcw,
  Settings2,
  Terminal,
  X,
} from "lucide-react";
import { OceanBackground } from "./components/OceanBackground";
import { OceanController } from "./components/OceanController";
import { QuickSettings } from "./components/QuickSettings";
import { bridge } from "./bridge";
import type { useWorkspace } from "./hooks/useWorkspace";
import { useTheme } from "./hooks/useTheme";
import {
  CommandPalette,
  type PaletteCommand,
} from "./components/CommandPalette";
import { profilePaletteCommands } from "./profilePaletteCommands";
import { effectiveProfileSettings } from "./activePersonalProfile";
import { PasteLastNotice } from "./components/PasteLastNotice";
import { ServiceRecovery } from "./components/ServiceRecovery";
import { UpdateNotice } from "./components/UpdateNotice";
import { OperationResumeNotice } from "./components/OperationResumeNotice";
import { RewriteDialog } from "./components/RewriteDialog";
import { PasteRecoveryNotice } from "./components/PasteRecoveryNotice";
import { HistoryDeletionNotice } from "./components/HistoryDeletionNotice";
import { Alert } from "./components/ui";
const LabPage = lazy(() =>
  import("./pages/LabPage").then((module) => ({ default: module.LabPage })),
);
const TechnicalPage = lazy(() =>
  import("./pages/TechnicalPage").then((module) => ({
    default: module.TechnicalPage,
  })),
);
const ModelsPage = lazy(() =>
  import("./pages/ModelsPage").then((module) => ({
    default: module.ModelsPage,
  })),
);
const VocabularyPage = lazy(() =>
  import("./pages/VocabularyPage").then((module) => ({
    default: module.VocabularyPage,
  })),
);
const HistoryPage = lazy(() =>
  import("./pages/HistoryPage").then((module) => ({
    default: module.HistoryPage,
  })),
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((module) => ({
    default: module.SettingsPage,
  })),
);
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
  models: {
    title: "Models",
    subtitle: "Speech and rewrite models, runtimes and backends",
  },
  technical: {
    title: "Editor",
    subtitle: "Literal editing · undo · explicit copy",
  },
  settings: {
    title: "Settings",
    subtitle: "Capture, output, runtime and application",
  },
};
function App({ workspace: w }: { workspace: ReturnType<typeof useWorkspace> }) {
  useTheme(w.settings.theme);
  const [modelTarget, setModelTarget] = useState<
    "decode" | "diagnostics" | null
  >(null);
  const [visited, setVisited] = useState<Set<Page>>(new Set(["home"]));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [focusHistory, setFocusHistory] = useState(false);
  useEffect(() => {
    const openCommands = (event: KeyboardEvent) => {
      if (
        !w.ready ||
        event.repeat ||
        event.altKey ||
        !(event.ctrlKey || event.metaKey) ||
        !event.shiftKey ||
        event.code !== "KeyP"
      )
        return;
      event.preventDefault();
      if (!document.querySelector("dialog[open]")) setPaletteOpen(true);
    };
    window.addEventListener("keydown", openCommands);
    return () => window.removeEventListener("keydown", openCommands);
  }, [w.ready]);
  useEffect(() => {
    setVisited((previous) =>
      previous.has(w.page) ? previous : new Set([...previous, w.page]),
    );
    document
      .getElementById("page-content")
      ?.scrollTo({ top: 0, behavior: "instant" });
    w.operations.hideRewrite();
  }, [w.page]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.altKey ||
        !(event.ctrlKey || event.metaKey) ||
        !event.shiftKey
      )
        return;
      const key = event.key.toLowerCase();
      if (key !== "m" && key !== "d") return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest(
          "input, textarea, select, [contenteditable='true'], [role='dialog']",
        )
      )
        return;
      if (document.querySelector("[role='dialog'][aria-modal='true']")) return;
      event.preventDefault();
      w.setPage("models");
      setModelTarget(key === "m" ? "decode" : "diagnostics");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [w.setPage]);
  const recording =
    w.status.phase === "listening" || w.status.phase === "paused";
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
  const { actions: baseTranscriptActions, onClearHistory } =
    createTranscriptCommands(w);
  const transcriptActions = {
    ...baseTranscriptActions,
    onCancelRewrite: (operationId: string) => bridge.cancelRewrite(operationId),
    onOpenRewrite: (record: Parameters<typeof w.operations.openRewrite>[0]) =>
      w.operations.openRewrite(record, w.page),
  };
  const rewrite = w.operations.rewriteOperation;
  const rewriteRecord = rewrite
    ? w.history.find((record) => record.id === rewrite.transcriptId)
    : undefined;
  const download = run(() => bridge.downloadUpdate());
  const install = run(() => bridge.installUpdate());
  const setup = run(() => bridge.setupModel());
  const cancelSetup = run(() => bridge.cancelModelSetup());
  const load = run(() => bridge.loadModel());
  const unload = run(() => bridge.unloadModel());
  const setupMagic = run(() => bridge.setupMagic());
  const cancelSetupMagic = run(() => bridge.cancelMagicSetup());
  const loadMagic = run(() => bridge.loadMagic());
  const unloadMagic = run(() => bridge.unloadMagic());
  const commands: PaletteCommand[] = [
    ...(
      [
        ["settings", "Open settings"],
        ["lab", "Open audio files"],
        ["technical", "Open technical text"],
        ["vocabulary", "Open personalization"],
      ] as const
    ).map(([page, label]) => ({ id: page, label, run: () => w.setPage(page) })),
    ...profilePaletteCommands(
      w.settings,
      (profile) =>
        w.activateProfile({
          action: "activate",
          id: profile.id,
          expectedProfile: profile,
          expectedCurrentSettings: effectiveProfileSettings(w.settings),
        }),
      {
        disabled:
          busy || w.saving
            ? "Finish the current capture, model operation, or settings save before switching profiles."
            : undefined,
        activeId: w.settings.activePersonalProfile?.id,
        global: () =>
          w.activateProfile({
            action: "global",
            expectedCurrentSettings: effectiveProfileSettings(w.settings),
          }),
      },
    ),
    {
      id: "record",
      label: recording ? "Stop dictation" : "Start dictation",
      keywords: "record microphone capture speech",
      disabled:
        !recording && (busy || needsSetup)
          ? needsSetup
            ? "Set up or repair speech in Models first."
            : "Finish the current model operation first."
          : undefined,
      run: () => w.action(() => bridge.toggleDictation()),
    },
    {
      id: "history",
      label: "Search transcript history",
      keywords: "find original corrected rewritten",
      run: () => {
        w.setPage("history");
        setFocusHistory(true);
      },
    },
    {
      id: "models",
      label: "Open model management",
      keywords: "speech rewriting runtime setup diagnostics",
      run: () => w.setPage("models"),
    },
    {
      id: "load-speech",
      label: "Load speech model",
      detail: "Prepare R2T2 for dictation.",
      disabled: busy
        ? "Finish the current capture or model operation first."
        : w.status.engine === "missing"
          ? "Install speech in Models first."
          : undefined,
      run: () => {
        w.setPage("models");
        load();
      },
    },
    {
      id: "unload-speech",
      label: "Unload speech model",
      detail: "Release speech model memory.",
      disabled: busy
        ? "Finish the current capture or model operation first."
        : w.status.engine !== "ready"
          ? "The speech model is not ready to unload."
          : undefined,
      run: () => {
        w.setPage("models");
        unload();
      },
    },
    {
      id: "load-rewrite",
      label: "Load rewriting model",
      detail: "Prepare the selected optional Qwen 3.5 model.",
      disabled: busy
        ? "Finish the current capture or model operation first."
        : w.magicStatus.engine === "missing"
          ? "Install rewriting in Models first."
          : undefined,
      run: () => {
        w.setPage("models");
        loadMagic();
      },
    },
    {
      id: "unload-rewrite",
      label: "Unload rewriting model",
      detail: "Release rewriting model memory.",
      disabled: busy
        ? "Finish the current capture or model operation first."
        : w.magicStatus.engine !== "ready"
          ? "The rewriting model is not ready to unload."
          : undefined,
      run: () => {
        w.setPage("models");
        unloadMagic();
      },
    },
  ];
  const [quickOpen, setQuickOpen] = useState(false);
  const panelOpen = quickOpen || w.page !== "home";
  useEffect(() => {
    if (w.page !== "home") setQuickOpen(false);
  }, [w.page]);
  const panelRef = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  const onboardingShown = useRef(false);
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    if (w.ready && !w.settings.onboardingComplete && !onboardingShown.current) {
      onboardingShown.current = true;
      if (w.status.engine === "missing") w.setPage("models");
    }
  }, [w.ready, w.settings.onboardingComplete, w.status.engine]);
  const closePanel = () => {
    setQuickOpen(false);
    w.setPage("home");
    if (!w.settings.onboardingComplete) void w.finishOnboarding(false);
  };
  const navigate = (page: Page) => {
    setQuickOpen(false);
    w.setPage(page);
  };
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (panelOpen) {
        panelRef.current?.focus({ preventScroll: true });
        const content = document.getElementById("page-content");
        if (content) content.scrollTop = 0;
      } else if (wasOpen.current)
        document
          .querySelector<HTMLButtonElement>('[aria-label="Open settings"]')
          ?.focus();
      wasOpen.current = panelOpen;
    });
    return () => cancelAnimationFrame(frame);
  }, [panelOpen, w.page]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        document.querySelector(
          'dialog[open], [role="dialog"][aria-modal="true"]',
        )
      )
        return;
      if (panelOpen) {
        event.preventDefault();
        closePanel();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  });
  const latest = w.history[0];
  return (
    <main
      className={`ocean-app ${panelOpen ? "panel-open" : ""}`}
      data-visible={visible}
    >
      <OceanBackground recording={w.status.phase === "listening"} />
      <a
        className="ocean-skip"
        href={
          w.status.phase === "listening" || w.status.phase === "paused"
            ? "#recording-stop-control"
            : "#recording-start-control"
        }
      >
        Skip to dictation controls
      </a>
      <div className={`workspace-notices ${panelOpen ? "in-panel" : ""}`}>
        {panelOpen && (
          <UpdateNotice
            status={w.updateStatus}
            busy={busy}
            onDownload={download}
            onInstall={install}
          />
        )}
        <HistoryDeletionNotice
          state={w.historyDeletion}
          onUndo={w.undoDeletion}
          onHistory={() => w.setPage("history")}
        />
        {w.ready && <ServiceRecovery recovery={w.serviceRecovery} />}
        {panelOpen && (
          <OperationResumeNotice
            operations={w.operations}
            onImport={() => w.setPage("lab")}
          />
        )}
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
        <PasteRecoveryNotice
          onCopied={() => w.setToast("Copied to clipboard — paste manually")}
        />
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
          if (w.page === "models" && !available && !retrying) return null;
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

        <PasteLastNotice
          status={w.pasteLastStatus}
          onCancel={w.cancelPasteLast}
        />
        {w.startupError && (
          <Alert
            action={
              <button className="secondary-button" onClick={w.retryStartup}>
                <RotateCcw /> Retry opening workspace
              </button>
            }
          >
            {w.startupError}
          </Alert>
        )}
      </div>
      <section
        ref={panelRef}
        className={`workspace-sheet ${quickOpen && w.page === "home" ? "quick-sheet" : "wide-sheet"}`}
        hidden={!panelOpen}
        aria-label={
          quickOpen && w.page === "home"
            ? "Quick settings"
            : `${pages[w.page].title} panel`
        }
        tabIndex={-1}
      >
        <header className="sheet-header">
          {w.page !== "home" && (
            <button
              className="sheet-icon"
              aria-label="Back to quick settings"
              title="Quick settings"
              onClick={() => {
                w.setPage("home");
                setQuickOpen(true);
              }}
            >
              <ArrowLeft />
            </button>
          )}
          <h1>
            {quickOpen && w.page === "home" ? "Settings" : pages[w.page].title}
          </h1>
          {w.page !== "home" && (
            <button
              className="sheet-icon"
              aria-label="Open command palette"
              title="Commands"
              onClick={() => setPaletteOpen(true)}
            >
              <Terminal />
            </button>
          )}
          <button
            className="sheet-icon"
            aria-label={
              !w.settings.onboardingComplete && w.page === "models"
                ? "Dismiss setup"
                : "Close panel"
            }
            title="Close"
            onClick={closePanel}
          >
            <X />
          </button>
        </header>
        <div
          className="sheet-content page-scroll"
          id="page-content"
          tabIndex={-1}
          role="region"
          aria-label={
            quickOpen && w.page === "home"
              ? "Quick settings controls"
              : pages[w.page].title
          }
        >
          {quickOpen && w.page === "home" && (
            <QuickSettings workspace={w} busy={busy} onNavigate={navigate} />
          )}
          <Suspense
            fallback={
              <div
                className="panel-loading"
                role="status"
                aria-label="Opening panel"
              >
                <LoaderCircle className="spin" />
              </div>
            }
          >
            {(visited.has("history") || w.page === "history") && (
              <Activity
                name="history"
                mode={w.page === "history" ? "visible" : "hidden"}
              >
                <div className="workspace-view">
                  <HistoryPage
                    focusSearch={focusHistory && !paletteOpen}
                    onSearchFocused={() => setFocusHistory(false)}
                    history={w.history}
                    view={w.historyView}
                    onViewChange={w.setHistoryView}
                    {...transcriptActions}
                    onClear={onClearHistory}
                    onExportSelection={w.exportSelection}
                    onDeleteSelection={w.deleteSelection}
                    deletionPending={w.historyDeletion?.phase === "pending"}
                  />
                </div>
              </Activity>
            )}
            {(visited.has("lab") || w.page === "lab") && (
              <Activity
                name="lab"
                mode={w.page === "lab" ? "visible" : "hidden"}
              >
                <div className="workspace-view">
                  <LabPage
                    {...transcriptActions}
                    history={w.history}
                    busy={busy}
                  />
                </div>
              </Activity>
            )}
            {(visited.has("technical") || w.page === "technical") && (
              <Activity
                name="technical"
                mode={w.page === "technical" ? "visible" : "hidden"}
              >
                <div className="workspace-view">
                  <TechnicalPage
                    history={w.history}
                    settings={w.settings}
                    busy={busy || w.saving}
                    onUpdateSettings={(patch) => w.saveSettings(patch, null)}
                    rewriteStatus={w.magicStatus}
                    onRewriteSetup={() => w.setPage("models")}
                  />
                </div>
              </Activity>
            )}
            {(visited.has("models") || w.page === "models") && (
              <Activity
                name="models"
                mode={w.page === "models" ? "visible" : "hidden"}
              >
                <div className="workspace-view">
                  <ModelsPage
                    onDone={closePanel}
                    focusTarget={modelTarget}
                    onTargetHandled={() => setModelTarget(null)}
                    onCancelSetup={cancelSetup}
                    onCancelSetupMagic={cancelSetupMagic}
                    status={w.status}
                    magicStatus={w.magicStatus}
                    settings={w.settings}
                    busy={busy || w.saving}
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
              </Activity>
            )}
            {(visited.has("vocabulary") || w.page === "vocabulary") && (
              <Activity
                name="vocabulary"
                mode={w.page === "vocabulary" ? "visible" : "hidden"}
              >
                <div className="workspace-view">
                  <VocabularyPage
                    words={w.settings.customWords}
                    saving={w.saving}
                    onChange={(customWords) =>
                      w.saveSettings({ customWords }, "Rules saved")
                    }
                  />
                </div>
              </Activity>
            )}
            {(visited.has("settings") || w.page === "settings") && (
              <Activity
                name="settings"
                mode={w.page === "settings" ? "visible" : "hidden"}
              >
                <div className="workspace-view">
                  <SettingsPage
                    onCancelSetup={cancelSetup}
                    onCancelSetupMagic={cancelSetupMagic}
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
                      void w.action(
                        () => bridge.testPaste(),
                        "Paste test shortcut sent — check your destination",
                      );
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
              </Activity>
            )}
          </Suspense>
          {w.page === "settings" && (
            <details className="disclosure">
              <summary>Rewrite selected text</summary>
              <SelectedTextWorkflow
                status={w.magicStatus}
                onSetup={() => navigate("models")}
              />
            </details>
          )}
        </div>
      </section>
      <OceanController
        navigation={
          panelOpen ? (
            <nav className="panel-navigation" aria-label="Workspace">
              {(
                [
                  { page: "home", label: "Controls", Icon: Home },
                  { page: "history", label: "History", Icon: Clock3 },
                  { page: "lab", label: "Audio files", Icon: AudioLines },
                  { page: "models", label: "Models", Icon: Cpu },
                  { page: "technical", label: "Editor", Icon: Code2 },
                  { page: "settings", label: "Settings", Icon: Settings2 },
                ] as const
              ).map(({ page, label, Icon }) => (
                <button
                  key={page}
                  className="sheet-icon"
                  title={label}
                  aria-label={label}
                  aria-current={w.page === page ? "page" : undefined}
                  onClick={() =>
                    page === "home" ? closePanel() : navigate(page)
                  }
                >
                  <Icon />
                </button>
              ))}
            </nav>
          ) : undefined
        }
        status={w.status}
        ready={w.ready}
        busy={busy}
        panelOpen={panelOpen}
        canCopy={!!latest}
        resultId={latest?.id}
        onRecord={() => w.action(() => bridge.toggleDictation())}
        onCopy={() =>
          latest
            ? w.action(() => bridge.copyText(deliveredText(latest)))
            : Promise.resolve(false)
        }
        onSetup={() => navigate("models")}
        onSettings={() => {
          if (panelOpen) closePanel();
          else {
            w.setPage("home");
            setQuickOpen(true);
          }
        }}
        onPause={() =>
          w.action(() =>
            w.status.phase === "paused"
              ? bridge.resumeDictation()
              : bridge.pauseDictation(),
          )
        }
        onCancel={() => w.action(() => bridge.cancelDictation())}
      />
      {rewrite && (
        <RewriteDialog
          key={rewrite.key}
          contextLabel={rewrite.label}
          text={rewriteRecord ? transcriptText(rewriteRecord) : rewrite.source}
          baseline={
            rewriteRecord ? deliveredText(rewriteRecord) : rewrite.baseline
          }
          sourceRevision={
            rewriteRecord
              ? transcriptSourceRevision(rewriteRecord)
              : rewrite.sourceRevision
          }
          sourceLanguage={rewrite.sourceLanguage}
          status={w.magicStatus}
          visible={rewrite.visible}
          onBackground={w.operations.hideRewrite}
          onOperationState={(phase) =>
            w.operations.rewriteState(rewrite.key, phase)
          }
          onClose={() => w.operations.closeRewrite(rewrite.key)}
          onSetup={() => w.setPage("models")}
          onCancelRewrite={bridge.cancelRewrite}
          onRewrite={(request) => w.operations.runRewrite(rewrite.key, request)}
          onApply={(result, source, sourceRevision) =>
            w.operations.applyRewrite(rewrite.key, () =>
              baseTranscriptActions.onSetRewrite!(
                rewrite.transcriptId,
                result,
                source,
                sourceRevision,
              ),
            )
          }
        />
      )}

      {paletteOpen && (
        <CommandPalette
          commands={commands}
          actionError={w.error}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {w.toast && (
        <div className={panelOpen ? "ocean-toast" : "sr-only"} role="status">
          <Check />
          <span>{w.toast}</span>
          <button
            className="sheet-icon"
            aria-label="Dismiss notification"
            onClick={() => w.setToast(null)}
          >
            <X />
          </button>
        </div>
      )}
    </main>
  );
}
export default App;
