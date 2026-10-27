import { ModelControl } from "./components/ModelControl";
import { useCallback, useEffect, useState } from "react";
import * as ipc from "./ipc";
import { insertMessage, settingsPatch } from "./helpers";
export type Page = "Home" | "History" | "Settings";
export const errorText = (error: unknown) => String(error);
export function useAppState() {
  const [status, setStatus] = useState<ipc.Status>();
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
      ipc.listMicrophones(),
      ipc.listLanguages(),
      ipc.listModels(),
    ])
      .then(([s, config, inputs, langs, available]) => {
        if (active) {
          setStatus(s);
          setSettings(config);
          setMicrophones(inputs);
          setLanguages(langs);
          setModels(available);
        }
      })
      .catch((e) => setNotice(errorText(e)));
    subscribe(ipc.onStatus(setStatus));
    subscribe(ipc.onMicLevel(setLevel));
    subscribe(
      ipc.onTranscript((value) => {
        setRecovery(value);
        setNotice(insertMessage(value.insert));
        ipc
          .getHistory(null, 5)
          .then(setHistory)
          .catch((e) => setNotice(errorText(e)));
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
  }, [query, page]);
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
  async function insert(entry: ipc.HistoryEntry) {
    try {
      const result = await ipc.reinsert(entry.id);
      setRecovery({ entry, insert: result });
      setNotice(insertMessage(result));
    } catch (e) {
      setRecovery({ entry, insert: { kind: "failed", reason: errorText(e) } });
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
    setStatus,
    settings,
    microphones,
    languages,
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
