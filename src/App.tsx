import { useEffect, useState } from "react";
import { AlertCircle, Check, LoaderCircle, Mic, Square } from "lucide-react";
import { bridge } from "./bridge";
import { DEFAULT_SETTINGS, modelById } from "./data";
import { PcmRecorder, listMicrophones } from "./recorder";
import { Sidebar } from "./components/Sidebar";
import { Overlay } from "./components/Overlay";
import { HomePage } from "./pages/HomePage";
import { LabPage } from "./pages/LabPage";
import { ModelsPage } from "./pages/ModelsPage";
import { VocabularyPage } from "./pages/VocabularyPage";
import { HistoryPage } from "./pages/HistoryPage";
import { SettingsPage } from "./pages/SettingsPage";
import type { AppSettings, DictationStatus, MicrophoneDevice, Page, PlatformCapabilities, TranscriptRecord } from "./types";

const initialStatus: DictationStatus = { phase: "idle", engine: "unloaded", message: "Loading your workspace" };

const PAGE_META: Record<Page, { title: string; description: string }> = {
  home: { title: "Dictation", description: "Record, review, and deliver speech without leaving this view." },
  lab: { title: "Speech Lab", description: "Transcribe files, recover verbatim detail, or align trusted text." },
  history: { title: "History", description: "Search paired transcripts and export text or timed captions." },
  vocabulary: { title: "Wordbook", description: "Persistent spelling, alias, and text-expansion rules." },
  models: { title: "Models & runtime", description: "Choose a CrisperWhisper checkpoint and manage its local engine." },
  settings: { title: "Settings", description: "Capture, transcription, delivery, and local-runtime preferences." },
};

function App() {
  const isOverlay = new URLSearchParams(window.location.search).has("overlay");
  const [page, setPage] = useState<Page>("home");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<DictationStatus>(initialStatus);
  const [history, setHistory] = useState<TranscriptRecord[]>([]);
  const [devices, setDevices] = useState<MicrophoneDevice[]>([{ deviceId: "default", label: "System default" }]);
  const [capabilities, setCapabilities] = useState<PlatformCapabilities | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const removeStatus = bridge.onStatus(setStatus);
    if (isOverlay) {
      void bridge.getStatus().then(setStatus).catch((error) => setStatus({ phase: "error", engine: "error", message: String(error) }));
      return removeStatus;
    }

    const recorder = new PcmRecorder();
    const removeRecorder = bridge.onRecorderCommand((command) => void recorder.handle(command));
    const removeTranscript = bridge.onTranscript((record) => {
      setHistory((items) => [record, ...items.filter((item) => item.id !== record.id)]);
      setToast("Transcript captured and ready");
    });
    void Promise.allSettled([bridge.getSettings(), bridge.getStatus(), bridge.getHistory(), bridge.getCapabilities()])
      .then(([settingsResult, statusResult, historyResult, capabilitiesResult]) => {
        if (settingsResult.status === "fulfilled") setSettings(settingsResult.value);
        if (statusResult.status === "fulfilled") setStatus(statusResult.value);
        if (historyResult.status === "fulfilled") setHistory(historyResult.value);
        if (capabilitiesResult.status === "fulfilled") setCapabilities(capabilitiesResult.value);
        const failure = [settingsResult, statusResult, historyResult].find((result) => result.status === "rejected");
        if (failure?.status === "rejected") setStatus({ phase: "error", engine: "error", message: String(failure.reason) });
      });
    return () => {
      removeStatus();
      removeRecorder();
      removeTranscript();
    };
  }, [isOverlay]);

  useEffect(() => {
    if (isOverlay || page !== "settings") return;
    let cancelled = false;
    void listMicrophones(true).then((available) => { if (!cancelled) setDevices(available); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [isOverlay, page]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  async function saveSettings(next: AppSettings, message: string | null = "Changes saved") {
    setSaving(true);
    try {
      const persisted = await bridge.updateSettings(next);
      setSettings(persisted);
      if (message) setToast(message);
    } catch (error) {
      setStatus({ ...status, phase: "error", message: String(error) });
    } finally {
      setSaving(false);
    }
  }

  async function action(run: () => Promise<void>, success?: string) {
    try {
      await run();
      if (success) setToast(success);
    } catch (error) {
      setStatus({ ...status, phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (isOverlay) return <Overlay status={status} />;

  const busy = ["preparing", "loading", "transcribing"].includes(status.phase);
  const recording = status.phase === "listening";
  const model = modelById(settings.model);
  const meta = PAGE_META[page];
  return (
    <div className="app-shell">
      <a className="skip-link" href="#page-content">Skip to content</a>
      <Sidebar page={page} onNavigate={setPage} status={status} />
      <main className="main-panel" id="page-content" tabIndex={-1} aria-busy={busy}>
        <header className="commandbar">
          <div className="view-title"><h1>{meta.title}</h1><p>{meta.description}</p></div>
          <div className="global-actions">
            <button className={`runtime-button phase-${status.phase}`} onClick={() => setPage("models")} title={status.detail ?? status.message} aria-label={`Model runtime: ${model.size}, ${status.engine}. ${status.message}`}>
              {busy ? <LoaderCircle className="spin" /> : status.phase === "error" ? <AlertCircle /> : <span className="live-dot" />}
              <span><strong>{model.size} · {status.engine}</strong><small role={status.phase === "error" ? "alert" : "status"} aria-live={status.phase === "error" ? "assertive" : "polite"}>{status.message}</small></span>
            </button>
            <kbd className="shortcut-hint">{settings.shortcut.split("CommandOrControl").join("Ctrl").split("+").join(" + ")}</kbd>
            <button className={`record-command ${recording ? "recording" : ""}`} disabled={busy} aria-pressed={recording} onClick={() => void bridge.toggleDictation()}>
              {recording ? <Square /> : <Mic />}<span>{recording ? "Stop" : "Record"}</span>
            </button>
          </div>
        </header>

        <div className="page-scroll">
          {page === "home" && <HomePage settings={settings} status={status} history={history} saving={saving} onNavigate={setPage} onUpdateSettings={(patch) => void saveSettings({ ...settings, ...patch }, null)} onCopy={(text) => void action(() => bridge.copyText(text), "Copied to clipboard")} />}
          {page === "lab" && <LabPage settings={settings} onResult={(record) => setHistory((items) => [record, ...items.filter((item) => item.id !== record.id)])} onToast={setToast} />}
          {page === "models" && <ModelsPage selected={settings.model} status={status} saving={saving} licenseAccepted={settings.modelLicenseAccepted} onSelect={(model) => void saveSettings({ ...settings, model }, "Model selection updated")} onSetup={() => void action(() => bridge.setupModel())} onLoad={() => void action(() => bridge.loadModel())} onUnload={() => void action(() => bridge.unloadModel(), "Model unloaded")} onOpenSettings={() => setPage("settings")} />}
          {page === "vocabulary" && <VocabularyPage words={settings.customWords} saving={saving} onChange={(customWords) => void saveSettings({ ...settings, customWords }, "Wordbook updated")} />}
          {page === "history" && <HistoryPage history={history} onCopy={(text) => void action(() => bridge.copyText(text), "Copied to clipboard")} onDelete={(id) => void action(() => bridge.deleteHistory(id).then(() => setHistory((items) => items.filter((item) => item.id !== id))))} onClear={() => void action(() => bridge.clearHistory().then(() => setHistory([])), "Local history cleared")} onExport={(id, format) => void action(() => bridge.exportTranscript(id, format).then((path) => { if (path) setToast(`Exported to ${path}`); }))} />}
          {page === "settings" && <SettingsPage settings={settings} devices={devices} capabilities={capabilities} status={status} saving={saving} onSave={saveSettings} onSetup={() => void action(() => bridge.setupModel())} onLoad={() => void action(() => bridge.loadModel())} onUnload={() => void action(() => bridge.unloadModel(), "Model unloaded")} onReset={() => void action(() => bridge.resetPythonEnvironment(), "Python environment removed")} />}
        </div>
      </main>
      {toast && <div className="toast" role="status" aria-live="polite"><Check />{toast}</div>}
    </div>
  );
}

export default App;
