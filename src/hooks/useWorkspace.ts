import { useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
import { DEFAULT_SETTINGS } from "../data";
import { PcmRecorder, listMicrophones } from "../recorder";
import { readStartupService } from "../startupServices";
import type {
  AppSettings,
  DictationStatus,
  MagicStatus,
  MicrophoneDevice,
  Page,
  PlatformCapabilities,
  ShortcutStatus,
  TranscriptRecord,
  UpdateStatus,
} from "../types";

export function useWorkspace() {
  const [page, setPage] = useState<Page>("home");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [status, setStatus] = useState<DictationStatus>({
    phase: "idle",
    engine: "unloaded",
    message: "Opening your workspace…",
  });
  const [magicStatus, setMagicStatus] = useState<MagicStatus>({
    phase: "idle",
    engine: "unloaded",
    message: "Checking Magic…",
  });
  const [shortcutStatus, setShortcutStatus] = useState<ShortcutStatus>({
    accelerator: DEFAULT_SETTINGS.shortcut,
    registered: false,
    method: "native",
    message: "Checking shortcut",
  });
  const [history, setHistory] = useState<TranscriptRecord[]>([]);
  const [devices, setDevices] = useState<MicrophoneDevice[]>([
    { deviceId: "default", label: "System default" },
  ]);
  const [capabilities, setCapabilities] = useState<PlatformCapabilities | null>(
    null,
  );
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({
    phase: "idle",
    currentVersion: "",
    message: "Checking version…",
  });
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settingsRef = useRef(settings);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const pendingSaves = useRef(0);
  const lifecycle = useRef({ alive: false });
  const report = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message : String(reason));
  const receiveSettings = (next: AppSettings) => {
    settingsRef.current = next;
    setSettings(next);
  };
  const receiveTranscript = (record: TranscriptRecord) =>
    setHistory((items) =>
      [record, ...items.filter((item) => item.id !== record.id)].slice(0, 500),
    );

  useEffect(() => {
    let alive = true;
    const owner = { alive: true };
    lifecycle.current = owner;
    const startup = new AbortController();
    const liveRecords = new Map<string, TranscriptRecord>();
    let readingHistory = true;
    const received = new Set<string>();
    const subscribe =
      <T>(name: string, receive: (value: T) => void) =>
      (value: T) => {
        if (!alive) return;
        received.add(name);
        receive(value);
      };
    const read = <T>(name: string, request: () => Promise<T>) =>
      readStartupService(name, request, startup.signal);
    setStartupError(null);
    const recorder = new PcmRecorder();
    const subscriptions = [
      bridge.onStatus(subscribe("speech status", setStatus)),
      bridge.onMagicStatus(subscribe("rewriting status", setMagicStatus)),
      bridge.onSettingsChanged(subscribe("settings", receiveSettings)),
      bridge.onNavigate((next) => { if (alive) setPage(next); }),
      bridge.onShortcutStatus(subscribe("shortcut status", setShortcutStatus)),
      bridge.onUpdateStatus(subscribe("update status", setUpdateStatus)),
      bridge.onRecorderCommand((command) => {
        if (!alive) return;
        void recorder.handle(command).catch((reason) => { if (alive) report(reason); });
      }),
      bridge.onTranscript((record) => {
        if (!alive) return;
        if (readingHistory) liveRecords.set(record.id, record);
        receiveTranscript(record);
      }),
    ];
    void bridge.recorderReady().catch((reason) => { if (alive) report(reason); });
    void Promise.allSettled([
      read("settings", () => bridge.getSettings()),
      read("speech status", () => bridge.getStatus()),
      read("rewriting status", () => bridge.getMagicStatus()),
      read("shortcut status", () => bridge.getShortcutStatus()),
      read("transcript history", () => bridge.getHistory()),
      read("platform capabilities", () => bridge.getCapabilities()),
      read("update status", () => bridge.getUpdateStatus()),
    ])
      .then(([next, speech, magic, shortcut, records, platform, update]) => {
        if (!alive) return;
        if (next.status === "rejected" || records.status === "rejected") {
          const reason =
            next.status === "rejected"
              ? next.reason
              : records.status === "rejected"
                ? records.reason
                : "Workspace unavailable";
          setStartupError(
            reason instanceof Error ? reason.message : String(reason),
          );
          return;
        }
        if (!received.has("settings")) receiveSettings(next.value);
        const initialHistory = new Map(records.value.map((record) => [record.id, record]));
        for (const record of liveRecords.values()) initialHistory.set(record.id, record);
        setHistory([...initialHistory.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 500));
        readingHistory = false;
        liveRecords.clear();
        if (!received.has("speech status")) {
          if (speech.status === "fulfilled") setStatus(speech.value);
          else
            setStatus({
              phase: "error",
              engine: "error",
              message:
                "Could not read speech engine status. Retry loading it in Models.",
            });
        }
        if (!received.has("rewriting status")) {
          if (magic.status === "fulfilled") setMagicStatus(magic.value);
          else
            setMagicStatus({
              phase: "error",
              engine: "error",
              message: "Rewriting is unavailable. Dictation can still be used.",
            });
        }
        if (!received.has("shortcut status")) {
          if (shortcut.status === "fulfilled")
            setShortcutStatus(shortcut.value);
          else
            setShortcutStatus((previous) => ({
              ...previous,
              registered: false,
              message: "Shortcut status is unavailable. Use the Record button.",
            }));
        }
        if (platform.status === "fulfilled") setCapabilities(platform.value);
        if (!received.has("update status")) {
          if (update.status === "fulfilled") setUpdateStatus(update.value);
          else
            setUpdateStatus((previous) => ({
              ...previous,
              phase: "error",
              message: "Could not read update status",
            }));
        }
        setReady(true);
      })
      .catch((reason: unknown) => {
        if (alive)
          setStartupError(
            reason instanceof Error ? reason.message : String(reason),
          );
      });
    return () => {
      alive = false;
      owner.alive = false;
      startup.abort();
      subscriptions.forEach((remove) => remove());
      void recorder.cancel().catch(() => { /* The retired owner cannot publish an error. */ });
    };
  }, [startupAttempt]);

  useEffect(() => {
    if (page !== "settings" && page !== "home") return;
    let alive = true;
    const refresh = () => {
      void listMicrophones(false)
        .then((next) => {
          if (alive) setDevices(next);
        })
        .catch(report);
    };
    refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener("devicechange", refresh);
    };
  }, [page]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(timer);
  }, [toast]);

  async function action(
    run: () => Promise<unknown>,
    success?: string,
  ): Promise<boolean> {
    const owner = lifecycle.current;
    if (!owner.alive) return false;
    try {
      await run();
      if (!owner.alive) return false;
      setError(null);
      if (success) setToast(success);
      return true;
    } catch (reason) {
      if (owner.alive) report(reason);
      return false;
    }
  }

  function saveSettings(
    patch: Partial<AppSettings>,
    message: string | null = "Changes saved",
  ): Promise<boolean> {
    const owner = lifecycle.current;
    if (!owner.alive) return Promise.resolve(false);
    pendingSaves.current += 1;
    setSaving(true);
    const run = saveQueue.current.then(async () => {
      try {
        if (!owner.alive) return false;
        const next = await bridge.updateSettings(patch);
        if (!owner.alive) return false;
        receiveSettings(next);
        setError(null);
        if (message) setToast(message);
        return true;
      } catch (reason) {
        if (owner.alive) report(reason);
        return false;
      } finally {
        pendingSaves.current -= 1;
        if (lifecycle.current.alive) setSaving(pendingSaves.current > 0);
      }
    });
    saveQueue.current = run;
    return run;
  }

  async function updateTranscript(
    id: string,
    text: string | null,
  ): Promise<boolean> {
    const owner = lifecycle.current;
    return action(
      async () => {
        if (text !== null && !text.trim())
          throw new Error("A correction cannot be empty");
        const updated = await bridge.updateTranscript(id, text);
        if (!owner.alive) return;
        setHistory((items) =>
          items.map((item) => (item.id === id ? updated : item)),
        );
      },
      text === null ? "Original restored" : "Correction saved",
    );
  }

  const finishOnboarding = async (openModels: boolean) => {
    if (await saveSettings({ onboardingComplete: true }, null)) {
      if (openModels) setPage("models");
    }
  };
  const copy = (text: string) => {
    void action(() => bridge.copyText(text), "Copied to clipboard");
  };
  const pasteLast = () => {
    setToast("Focus a text field — pasting in 3 seconds…");
    void action(() => bridge.pasteLastTranscript(), "Last result pasted");
  };
  return {
    page,
    setPage,
    settings,
    ready,
    startupError,
    retryStartup: () => {
      lifecycle.current.alive = false;
      setReady(false);
      setStartupAttempt((attempt) => attempt + 1);
    },
    status,
    magicStatus,
    shortcutStatus,
    history,
    setHistory,
    devices,
    capabilities,
    updateStatus,
    saving,
    toast,
    setToast,
    error,
    setError,
    action,
    saveSettings,
    updateTranscript,
    finishOnboarding,
    copy,
    pasteLast,
    receiveTranscript,
  };
}
