import { ModelControl } from "./components/ModelControl";
import { useCallback, useEffect, useState } from "react";
import * as ipc from "./ipc";
import { insertMessage, meterLevel, settingsPatch } from "./helpers";
export type Page = "Home" | "History" | "Cleanup" | "Settings";
export const errorText = (error: unknown) => String(error);
export function useAppState() {
  const [status, setStatus] = useState<ipc.Status>();
  const [cleanupStatus, setCleanupStatus] = useState<ipc.CleanupStatus>();
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
  const [historyVersion, setHistoryVersion] = useState(0);
  // Listing microphones can fail while PipeWire restarts; it must never block startup.
  const refreshMicrophones = useCallback(
    () =>
      ipc
        .listMicrophones()
        .then(setMicrophones)
        .catch((e) => setNotice(`Could not list microphones: ${errorText(e)}`)),
    [],
  );
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
      ipc.listLanguages(),
      ipc.listModels(),
    ])
      .then(([s, config, langs, available]) => {
        if (active) {
          setStatus(s);
          setSettings(config);
          setLanguages(langs);
          setModels(available);
        }
      })
      .catch((e) => setNotice(errorText(e)));
    subscribe(ipc.onCleanupStatus(setCleanupStatus));
    void ipc
      .getCleanupStatus()
      .then(setCleanupStatus)
      .catch((e) => setNotice(errorText(e)));
    subscribe(ipc.onStatus(setStatus));
    subscribe(ipc.onMicLevel((rms) => setLevel(meterLevel(rms))));
    subscribe(
      ipc.onTranscript((value) => {
        setRecovery(value);
        setNotice(insertMessage(value.insert));
        setHistoryVersion((v) => v + 1);
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
  }, [query, page, historyVersion]);
  useEffect(() => {
    if (page === "Settings" || step === 0) void refreshMicrophones();
  }, [page, step, refreshMicrophones]);
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
  useEffect(() => {
    if (
      settings?.firstRunDone &&
      !settings.cleanupModelOk &&
      cleanupStatus?.state === "missing" &&
      !localStorage.getItem("cleanup-notice")
    ) {
      localStorage.setItem("cleanup-notice", "1");
      setNotice("New: text cleanup. Download it (5.2 GB) on the Cleanup page.");
    }
  }, [settings, cleanupStatus]);
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
  async function insert(entry: ipc.HistoryEntry, raw = false) {
    // The recovery card shows the text that was meant to go in.
    const shown =
      raw && entry.raw != null ? { ...entry, text: entry.raw } : entry;
    try {
      const result = await ipc.reinsert(entry.id, raw);
      setRecovery({ entry: shown, insert: result });
      setNotice(insertMessage(result));
    } catch (e) {
      setRecovery({
        entry: shown,
        insert: { kind: "failed", reason: errorText(e) },
      });
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
    <ModelControl
      {...{
        settings,
        models,
        selectedModel,
        progress,
        downloading,
        modelReady,
        update,
        download,
        cancel,
      }}
    />
  );
  return {
    status,
    cleanupStatus,
    setStatus,
    settings,
    microphones,
    languages,
    models,
    history,
    page,
    setPage,
    query,
    setQuery,
    step,
    setStep,
    level,
    notice,
    setNotice,
    recovery,
    permission,
    setPermission,
    confirmClear,
    setConfirmClear,
    hotkeyHint,
    setHotkeyHint,
    refreshHistory,
    update,
    copy,
    insert,
    modelReady,
    trigger,
    modelControl,
  };
}
export type AppState = ReturnType<typeof useAppState>;
