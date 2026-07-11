import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, LoaderCircle, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { bridge } from "./bridge";
import { DEFAULT_SETTINGS, PARAKEET_LANGUAGES } from "./data";
import { Sidebar } from "./components/Sidebar";
import type { AppSettings, DictationStatus, Page, TranscriptRecord } from "./types";

const HomePage = lazy(() => import("./pages/HomePage").then((module) => ({ default: module.HomePage })));
const ModelsPage = lazy(() => import("./pages/ModelsPage").then((module) => ({ default: module.ModelsPage })));
const VocabularyPage = lazy(() => import("./pages/VocabularyPage").then((module) => ({ default: module.VocabularyPage })));
const HistoryPage = lazy(() => import("./pages/HistoryPage").then((module) => ({ default: module.HistoryPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const appWindow = getCurrentWindow();
type ResizeDirection = "North" | "NorthEast" | "East" | "SouthEast" | "South" | "SouthWest" | "West" | "NorthWest";
const resizeDirections: ResizeDirection[] = ["North", "NorthEast", "East", "SouthEast", "South", "SouthWest", "West", "NorthWest"];

function App() {
  const [page, setPage] = useState<Page>("home");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<DictationStatus>({ phase: "idle", message: "Loading your workspace" });
  const [history, setHistory] = useState<TranscriptRecord[]>([]);
  const [devices, setDevices] = useState<string[]>(["default"]);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    void Promise.allSettled([bridge.getSettings(), bridge.getStatus(), bridge.getHistory()])
      .then(([settingsResult, statusResult, historyResult]) => {
        if (settingsResult.status === "fulfilled") setSettings(settingsResult.value);
        if (statusResult.status === "fulfilled") setStatus(statusResult.value);
        if (historyResult.status === "fulfilled") setHistory(historyResult.value);

        const firstFailure = [settingsResult, statusResult, historyResult].find((result) => result.status === "rejected");
        if (firstFailure?.status === "rejected") {
          setStatus({ phase: "error", message: String(firstFailure.reason) });
        }
      });

    const statusListener = bridge.onStatus(setStatus);
    const transcriptListener = bridge.onTranscript((record) => {
      setHistory((items) => [record, ...items.filter((item) => item.id !== record.id)]);
      setToast("Transcript captured and ready");
    });

    return () => {
      void statusListener.then((unlisten) => unlisten());
      void transcriptListener.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (page !== "settings") return;

    let cancelled = false;
    void bridge.listInputDevices()
      .then((availableDevices) => {
        if (!cancelled) {
          setDevices(availableDevices.length ? availableDevices : ["default"]);
        }
      })
      .catch(() => {
        if (!cancelled) setDevices(["default"]);
      });

    return () => {
      cancelled = true;
    };
  }, [page]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const pageTitle = useMemo(() => ({
    home: "Overview", models: "Model studio", vocabulary: "My vocabulary", history: "History", settings: "Settings",
  }[page]), [page]);

  async function saveSettings(next: AppSettings, message = "Changes saved"): Promise<boolean> {
    setSettings(next);
    setSaving(true);
    try {
      const persisted = await bridge.updateSettings(next);
      setSettings(persisted);
      setToast(message);
      return true;
    } catch (error) {
      setStatus({ phase: "error", message: String(error) });
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function resetPythonEnvironment() {
    try {
      await bridge.resetPythonEnvironment();
      setStatus({ phase: "idle", message: "Python environment removed. Set up a model when ready." });
      setToast("Python environment removed");
    } catch (error) {
      setStatus({ phase: "error", message: String(error) });
    }
  }

  async function setupModelEnvironment() {
    try {
      setStatus({ phase: "bootstrapping", message: "Starting local model setup…" });
      await bridge.setupModel();
      while (true) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        const runtimeStatus = await bridge.getStatus();
        setStatus(runtimeStatus);
        if (runtimeStatus.phase !== "bootstrapping") break;
      }
    } catch (error) {
      setStatus({ phase: "error", message: String(error) });
    }
  }

  async function selectModel(model: AppSettings["model"]) {
    const next = {
      ...settings,
      model,
      language: model === "parakeetTdt06bV3" && !PARAKEET_LANGUAGES.has(settings.language) ? "auto" : settings.language,
    };
    if (await saveSettings(next, "Model switched — preparing local runtime")) {
      await setupModelEnvironment();
    }
  }

  return (
    <div className="app-shell">
      <Sidebar page={page} onNavigate={setPage} status={status} />
      <main className="main-panel">
        <header className="topbar" data-tauri-drag-region>
          <div data-tauri-drag-region>
            <p className="eyebrow">DELULU TALKS</p>
            <h1>{pageTitle}</h1>
          </div>
          <div className="window-right">
            <div className={`runtime-chip phase-${status.phase}`}>
              {status.phase === "bootstrapping" || status.phase === "transcribing" ? <LoaderCircle className="spin" /> : status.phase === "error" ? <AlertCircle /> : <span className="live-dot" />}
              <span>{status.phase === "idle" ? "Engine ready" : status.phase}</span>
            </div>
            <div className="window-controls">
              <button type="button" title="Minimize" aria-label="Minimize window" onClick={() => void appWindow.minimize()}><Minus /></button>
              <button type="button" title="Maximize or restore" aria-label="Maximize or restore window" onClick={() => void appWindow.toggleMaximize()}><Square /></button>
              <button type="button" className="window-close" title="Close" aria-label="Close window" onClick={() => void appWindow.close()}><X /></button>
            </div>
          </div>
        </header>

        <div className="page-scroll">
          <Suspense fallback={<div className="page-loading"><LoaderCircle className="spin" /><span>Loading view…</span></div>}>
            {page === "home" && <HomePage settings={settings} status={status} history={history} onToggle={() => void bridge.toggleDictation()} onNavigate={setPage} onCopy={(text) => void bridge.copyText(text).then(() => setToast("Copied to clipboard"))} />}
            {page === "models" && <ModelsPage selected={settings.model} saving={saving} settingUp={status.phase === "bootstrapping"} onSelect={(model) => void selectModel(model)} onSetup={() => void setupModelEnvironment()} />}
            {page === "vocabulary" && <VocabularyPage words={settings.customWords} saving={saving} onChange={(customWords) => void saveSettings({ ...settings, customWords }, "Vocabulary updated")} />}
            {page === "history" && <HistoryPage history={history} onCopy={(text) => void bridge.copyText(text).then(() => setToast("Copied to clipboard"))} onDelete={(id) => void bridge.deleteHistory(id).then(() => setHistory((items) => items.filter((item) => item.id !== id)))} onClear={() => void bridge.clearHistory().then(() => setHistory([]))} />}
            {page === "settings" && <SettingsPage settings={settings} devices={devices} saving={saving} onSave={saveSettings} onSetup={() => void setupModelEnvironment()} onReset={() => void resetPythonEnvironment()} />}
          </Suspense>
        </div>
      </main>

      {toast && <div className="toast"><Check />{toast}</div>}
      {resizeDirections.map((direction) => (
        <div
          key={direction}
          className={`resize-handle resize-${direction.toLowerCase()}`}
          onMouseDown={(event) => {
            event.preventDefault();
            void appWindow.startResizeDragging(direction);
          }}
        />
      ))}
    </div>
  );
}

export default App;
