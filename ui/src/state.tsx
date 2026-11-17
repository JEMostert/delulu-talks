import { ModelControl } from "./components/ModelControl";
import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "./ipc";
import { insertMessage, meterLevel, settingsPatch } from "./helpers";
import { useRadio } from "./useRadio";
export type Page =
  "Dictate" | "Vocabulary" | "Delulu FM" | "Voice" | "Models" | "Settings";
/** The newest transcripts Dictate loads; search reaches older ones. */
export const HISTORY_LIMIT = 1000;
export const errorText = (error: unknown) => String(error);
export function useAppState() {
  const [status, setStatus] = useState<ipc.Status>();
  const [cleanupStatus, setCleanupStatus] = useState<ipc.CleanupStatus>();
  const [settings, setSettings] = useState<ipc.Settings>();
  const [microphones, setMicrophones] = useState<ipc.InputDevice[]>([]);
  const [languages, setLanguages] = useState<ipc.Language[]>([]);
  const [models, setModels] = useState<ipc.ModelStatus[]>([]);
  const [history, setHistory] = useState<ipc.HistoryEntry[]>([]);
  const [page, setPage] = useState<Page>("Dictate");
  const [query, setQuery] = useState("");
  /** Opens a page with a fresh search. */
  const navigate = useCallback((next: Page) => {
    setPage(next);
    setQuery("");
  }, []);
  const [step, setStep] = useState(0);
  const [level, setLevel] = useState(0);
  const [progress, setProgress] = useState<ipc.ModelDownload>();
  const [downloading, setDownloading] = useState(false);
  const [notice, setNotice] = useState("");
  const [recovery, setRecovery] = useState<ipc.TranscriptEvent>();
  const [permission, setPermission] = useState<ipc.InsertStatus>();
  const [confirmClear, setConfirmClear] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const hasSettings = useRef(false);
  hasSettings.current = settings != null;
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
        .getHistory(query || null, HISTORY_LIMIT)
        .then(setHistory)
        .catch((e) => setNotice(errorText(e))),
    [query],
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
    subscribe(
      ipc.onStatus((value) => {
        setStatus(value);
        // A window that started before the daemon has no settings yet: fetch
        // them once the daemon answers.
        if (!hasSettings.current && value.phase !== "error") {
          void Promise.all([
            ipc.getSettings(),
            ipc.listLanguages(),
            ipc.listModels(),
          ])
            .then(([config, langs, available]) => {
              if (!active) return;
              setSettings(config);
              setLanguages(langs);
              setModels(available);
              // The "not running" notice is out of date, and History is there now.
              setNotice("");
              setHistoryVersion((v) => v + 1);
            })
            .catch(() => {});
        }
      }),
    );
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
  // Only Dictate shows history; it loads again whenever you come back.
  const historyShown = page === "Dictate";
  useEffect(() => {
    if (!historyShown) return;
    let active = true;
    ipc
      .getHistory(query || null, HISTORY_LIMIT)
      .then((entries) => {
        if (active) setHistory(entries);
      })
      .catch((e) => {
        if (active) setNotice(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [query, historyShown, historyVersion]);
  useEffect(() => {
    if (page === "Dictate" || step === 0) void refreshMicrophones();
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
      setNotice("New: text cleanup. Download it (5.2 GB) at Clean up text.");
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
  // A model this version no longer runs was selected: settings now name its
  // replacement. Say so once and download it, so dictation works again.
  const replacing = useRef(false);
  useEffect(() => {
    if (
      !settings?.firstRunDone ||
      !selectedModel?.replaces ||
      selectedModel.downloaded ||
      downloading ||
      replacing.current
    )
      return;
    replacing.current = true;
    setNotice(
      `${selectedModel.replaces} was replaced by ${selectedModel.label}. Downloading it now (${Math.round(selectedModel.bytes / 1000000)} MB).`,
    );
    void download();
  }, [settings?.firstRunDone, selectedModel, downloading]);
  const modelReady =
    selectedModel?.downloaded ||
    (progress != null &&
      progress.id === settings?.model &&
      progress.finished &&
      !progress.error);
  const trigger = status?.hotkey.trigger ?? "Not assigned";
  const modelProps = {
    settings,
    models,
    selectedModel,
    progress,
    downloading,
    modelReady,
    update,
    download,
    cancel,
  };
  const modelControl = <ModelControl {...modelProps} />;
  const radio = useRadio(
    Boolean(settings?.radio),
    page === "Delulu FM",
    setNotice,
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
    navigate,
    query,
    setQuery,
    step,
    setStep,
    level,
    notice,
    setNotice,
    recovery,
    setRecovery,
    permission,
    setPermission,
    confirmClear,
    setConfirmClear,
    refreshHistory,
    update,
    copy,
    insert,
    modelReady,
    trigger,
    modelProps,
    modelControl,
    radio,
  };
}
export type AppState = ReturnType<typeof useAppState>;
