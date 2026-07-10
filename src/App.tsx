import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, LoaderCircle } from "lucide-react";
import { bridge } from "./bridge";
import { DEFAULT_SETTINGS } from "./data";
import { Sidebar } from "./components/Sidebar";
import { Overlay } from "./components/Overlay";
import { HomePage } from "./pages/HomePage";
import { ModelsPage } from "./pages/ModelsPage";
import { VocabularyPage } from "./pages/VocabularyPage";
import { HistoryPage } from "./pages/HistoryPage";
import { SettingsPage } from "./pages/SettingsPage";
import type { AppSettings, DictationStatus, Page, TranscriptRecord } from "./types";

function App() {
  const isOverlay = new URLSearchParams(window.location.search).has("overlay");
  const [page, setPage] = useState<Page>("home");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<DictationStatus>({ phase: "idle", message: "Loading your workspace" });
  const [history, setHistory] = useState<TranscriptRecord[]>([]);
  const [devices, setDevices] = useState<string[]>(["default"]);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (isOverlay) {
      const statusListener = bridge.onStatus(setStatus);
      void bridge.getStatus().then(setStatus).catch((error) => {
        setStatus({ phase: "error", message: String(error) });
      });

      return () => {
        void statusListener.then((unlisten) => unlisten());
      };
    }

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
  }, [isOverlay]);

  useEffect(() => {
    if (isOverlay || page !== "settings") return;

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
  }, [isOverlay, page]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const pageTitle = useMemo(() => ({
    home: "Home", models: "Model studio", vocabulary: "My vocabulary", history: "History", settings: "Settings",
  }[page]), [page]);

  async function saveSettings(next: AppSettings, message = "Changes saved") {
    setSettings(next);
    setSaving(true);
    try {
      const persisted = await bridge.updateSettings(next);
      setSettings(persisted);
      setToast(message);
    } catch (error) {
      setStatus({ phase: "error", message: String(error) });
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
    } catch (error) {
      setStatus({ phase: "error", message: String(error) });
    }
  }

  if (isOverlay) {
    return <Overlay status={status} />;
  }

  return (
    <div className="app-shell">
      <Sidebar page={page} onNavigate={setPage} status={status} />
      <main className="main-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">DELULU TALKS</p>
            <h1>{pageTitle}</h1>
          </div>
          <div className={`runtime-chip phase-${status.phase}`}>
            {status.phase === "bootstrapping" || status.phase === "transcribing" ? <LoaderCircle className="spin" /> : status.phase === "error" ? <AlertCircle /> : <span className="live-dot" />}
            <span>{status.phase === "idle" ? "Engine ready" : status.phase}</span>
          </div>
        </header>

        <div className="page-scroll">
          {page === "home" && <HomePage settings={settings} status={status} history={history} onToggle={() => void bridge.toggleDictation()} onNavigate={setPage} onCopy={(text) => void bridge.copyText(text).then(() => setToast("Copied to clipboard"))} />}
          {page === "models" && <ModelsPage selected={settings.model} saving={saving} onSelect={(model) => void saveSettings({ ...settings, model }, "Model switched — setup may be required")} onSetup={() => void setupModelEnvironment()} />}
          {page === "vocabulary" && <VocabularyPage words={settings.customWords} saving={saving} onChange={(customWords) => void saveSettings({ ...settings, customWords }, "Vocabulary updated")} />}
          {page === "history" && <HistoryPage history={history} onCopy={(text) => void bridge.copyText(text).then(() => setToast("Copied to clipboard"))} onDelete={(id) => void bridge.deleteHistory(id).then(() => setHistory((items) => items.filter((item) => item.id !== id)))} onClear={() => void bridge.clearHistory().then(() => setHistory([]))} />}
          {page === "settings" && <SettingsPage settings={settings} devices={devices} saving={saving} onSave={saveSettings} onSetup={() => void setupModelEnvironment()} onReset={() => void resetPythonEnvironment()} />}
        </div>
      </main>

      {toast && <div className="toast"><Check />{toast}</div>}
    </div>
  );
}

export default App;
