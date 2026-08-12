import { useEffect, useState } from "react";
import { AlertCircle, Check, LoaderCircle, Mic, Square } from "lucide-react";
import { bridge } from "./bridge";
import { DEFAULT_SETTINGS, modelById } from "./data";
import { PcmRecorder, listMicrophones } from "./recorder";
import { originalTranscriptText } from "./transcriptText";
import { Sidebar } from "./components/Sidebar";
import { Overlay } from "./components/Overlay";
import { HomePage } from "./pages/HomePage";
import { LabPage } from "./pages/LabPage";
import { MagicPage } from "./pages/MagicPage";
import { ModelsPage } from "./pages/ModelsPage";
import { VocabularyPage } from "./pages/VocabularyPage";
import { HistoryPage } from "./pages/HistoryPage";
import { SettingsPage } from "./pages/SettingsPage";
import type { AppSettings, DictationStatus, MagicStatus, MicrophoneDevice, Page, PlatformCapabilities, ShortcutStatus, TranscriptRecord, TranscriptVersion } from "./types";

const initialStatus: DictationStatus = { phase: "idle", engine: "unloaded", message: "Loading your workspace" };
const initialMagicStatus: MagicStatus = { phase: "idle", engine: "unloaded", message: "Loading Magic" };
const initialShortcutStatus: ShortcutStatus = { accelerator: DEFAULT_SETTINGS.shortcut, registered: false, method: "native", message: "Checking shortcut", lastTriggeredAt: null };

const PAGE_META: Record<Page, { title: string; description: string }> = {
  home: { title: "Dictation", description: "Record, review, and deliver speech without leaving this view." },
  magic: { title: "Magic", description: "Turn rough transcripts and drafts into writing that fits the job." },
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
  const [magicStatus, setMagicStatus] = useState<MagicStatus>(initialMagicStatus);
  const [shortcutStatus, setShortcutStatus] = useState<ShortcutStatus>(initialShortcutStatus);
  const [history, setHistory] = useState<TranscriptRecord[]>([]);
  const [devices, setDevices] = useState<MicrophoneDevice[]>([{ deviceId: "default", label: "System default" }]);
  const [capabilities, setCapabilities] = useState<PlatformCapabilities | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const removeStatus = bridge.onStatus(setStatus);
    const removeMagicStatus = bridge.onMagicStatus(setMagicStatus);
    const removeShortcutStatus = bridge.onShortcutStatus(setShortcutStatus);
    if (isOverlay) {
      void bridge.getStatus().then(setStatus).catch((error) => setStatus({ phase: "error", engine: "error", message: String(error) }));
      return () => { removeStatus(); removeMagicStatus(); removeShortcutStatus(); };
    }

    const recorder = new PcmRecorder();
    const removeRecorder = bridge.onRecorderCommand((command) => void recorder.handle(command));
    const removeTranscript = bridge.onTranscript((record) => {
      setHistory((items) => [record, ...items.filter((item) => item.id !== record.id)]);
      setToast(record.magicText ? "Magic result captured and ready" : "Transcript captured and ready");
    });
    void Promise.allSettled([bridge.getSettings(), bridge.getStatus(), bridge.getMagicStatus(), bridge.getShortcutStatus(), bridge.getHistory(), bridge.getCapabilities()])
      .then(([settingsResult, statusResult, magicStatusResult, shortcutStatusResult, historyResult, capabilitiesResult]) => {
        if (settingsResult.status === "fulfilled") setSettings(settingsResult.value);
        if (statusResult.status === "fulfilled") setStatus(statusResult.value);
        if (magicStatusResult.status === "fulfilled") setMagicStatus(magicStatusResult.value);
        if (shortcutStatusResult.status === "fulfilled") setShortcutStatus(shortcutStatusResult.value);
        if (historyResult.status === "fulfilled") setHistory(historyResult.value);
        if (capabilitiesResult.status === "fulfilled") setCapabilities(capabilitiesResult.value);
        const failure = [settingsResult, statusResult, historyResult].find((result) => result.status === "rejected");
        if (failure?.status === "rejected") setStatus({ phase: "error", engine: "error", message: String(failure.reason) });
      });
    return () => {
      removeStatus();
      removeMagicStatus();
      removeShortcutStatus();
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

  async function magicAction(run: () => Promise<void>, success?: string) {
    try {
      await run();
      if (success) setToast(success);
    } catch (error) {
      setMagicStatus({ ...magicStatus, phase: "error", engine: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function updateTranscript(id: string, version: TranscriptVersion, text: string | null) {
    try {
      if (!settings.keepHistory) {
        setHistory((items) => items.map((item) => {
          if (item.id !== id) return item;
          const normalized = text?.trim() ?? null;
          const correction = normalized === originalTranscriptText(item, version) ? null : normalized;
          return version === "intended" ? { ...item, editedIntendedText: correction } : { ...item, editedVerbatimText: correction };
        }));
        setToast(text === null ? "Original transcript restored" : "Correction applied for this session");
        return true;
      }
      const updated = await bridge.updateTranscript(id, version, text);
      setHistory((items) => items.map((item) => item.id === id ? updated : item));
      setToast(text === null ? "Original transcript restored" : "Correction saved locally");
      return true;
    } catch (error) {
      setStatus({ ...status, phase: "error", message: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  async function acceptModelLicense() {
    setSaving(true);
    try {
      const persisted = await bridge.updateSettings({ ...settings, modelLicenseAccepted: true });
      setSettings(persisted);
      setToast("Model license accepted");
      return true;
    } catch (error) {
      setStatus({ ...status, phase: "error", message: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      setSaving(false);
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
      <Sidebar page={page} onNavigate={setPage} status={status} magicStatus={magicStatus} />
      <main className="main-panel" id="page-content" tabIndex={-1} aria-busy={busy}>
        <header className="commandbar">
          <div className="view-title"><h1>{meta.title}</h1><p>{meta.description}</p></div>
          <div className="global-actions">
            <button className={`runtime-button phase-${status.phase}`} onClick={() => setPage("models")} title={status.detail ?? status.message} aria-label={`Model runtime: ${model.size}, ${status.engine}. ${status.message}`}>
              {busy ? <LoaderCircle className="spin" /> : status.phase === "error" ? <AlertCircle /> : <span className="live-dot" />}
              <span><strong>{model.size} · {status.engine}</strong><small role={status.phase === "error" ? "alert" : "status"} aria-live={status.phase === "error" ? "assertive" : "polite"}>{status.message}</small></span>
            </button>
            <kbd className={`shortcut-hint ${shortcutStatus.registered ? "ready" : "unavailable"}`} title={shortcutStatus.message}>{shortcutStatus.accelerator.split("CommandOrControl").join("Ctrl").split("+").join(" + ")}</kbd>
            <button className={`record-command ${recording ? "recording" : ""}`} disabled={busy} aria-pressed={recording} onClick={() => void bridge.toggleDictation()}>
              {recording ? <Square /> : <Mic />}<span>{recording ? "Stop" : "Record"}</span>
            </button>
          </div>
        </header>

        <div className="page-scroll" key={page}>
          {page === "home" && <HomePage settings={settings} status={status} history={history} saving={saving} onNavigate={setPage} onUpdateSettings={(patch) => void saveSettings({ ...settings, ...patch }, null)} onUpdateTranscript={updateTranscript} onCopy={(text) => void action(() => bridge.copyText(text), "Copied to clipboard")} />}
          {page === "magic" && <MagicPage settings={settings} status={magicStatus} history={history} saving={saving} onUpdateSettings={(patch) => void saveSettings({ ...settings, ...patch }, "Magic settings updated")} onSetup={() => void magicAction(() => bridge.setupMagic())} onLoad={() => void magicAction(() => bridge.loadMagic())} onUnload={() => void magicAction(() => bridge.unloadMagic(), "Magic model unloaded")} onRewrite={(request) => bridge.rewriteMagic(request)} onCopy={(text) => void action(() => bridge.copyText(text), "Magic output copied")} onToast={setToast} />}
          {page === "lab" && <LabPage settings={settings} onResult={(record) => setHistory((items) => [record, ...items.filter((item) => item.id !== record.id)])} onToast={setToast} />}
          {page === "models" && <ModelsPage selected={settings.model} status={status} saving={saving} licenseAccepted={settings.modelLicenseAccepted} onSelect={(model) => void saveSettings({ ...settings, model }, "Model selection updated")} onSetup={() => void action(() => bridge.setupModel())} onLoad={() => void action(() => bridge.loadModel())} onUnload={() => void action(() => bridge.unloadModel(), "Model unloaded")} onAcceptLicense={acceptModelLicense} />}
          {page === "vocabulary" && <VocabularyPage words={settings.customWords} saving={saving} onChange={(customWords) => void saveSettings({ ...settings, customWords }, "Wordbook updated")} />}
          {page === "history" && <HistoryPage history={history} onUpdateTranscript={updateTranscript} onCopy={(text) => void action(() => bridge.copyText(text), "Copied to clipboard")} onDelete={(id) => void action(() => bridge.deleteHistory(id).then(() => setHistory((items) => items.filter((item) => item.id !== id))))} onClear={() => void action(() => bridge.clearHistory().then(() => setHistory([])), "Local history cleared")} onExport={(id, format) => void action(() => bridge.exportTranscript(id, format).then((path) => { if (path) setToast(`Exported to ${path}`); }))} />}
          {page === "settings" && <SettingsPage settings={settings} devices={devices} capabilities={capabilities} shortcutStatus={shortcutStatus} status={status} magicStatus={magicStatus} saving={saving} onSave={saveSettings} onConfigureShortcut={() => void action(() => bridge.configureShortcut())} onSetup={() => void action(() => bridge.setupModel())} onLoad={() => void action(() => bridge.loadModel())} onUnload={() => void action(() => bridge.unloadModel(), "Model unloaded")} onSetupMagic={() => void magicAction(() => bridge.setupMagic())} onLoadMagic={() => void magicAction(() => bridge.loadMagic())} onUnloadMagic={() => void magicAction(() => bridge.unloadMagic(), "Magic model unloaded")} onReset={() => void action(() => bridge.resetPythonEnvironment(), "Python environment removed")} />}
        </div>
      </main>
      {toast && <div className="toast" role="status" aria-live="polite"><Check />{toast}</div>}
    </div>
  );
}

export default App;
