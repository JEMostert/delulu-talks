import type {
  CaptureProfileSnapshot,
  ProfileActivationCommand,
} from "../activePersonalProfile";
import type { PersonalProfileCommand } from "../personalProfileCommands";
import { useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
import { retainSessionTranscripts } from "../sessionTranscriptRetention";
import { DEFAULT_SETTINGS } from "../data";
import { PcmRecorder, listMicrophones } from "../recorder";
import { readStartupService } from "../startupServices";
import { useWorkspaceOperations } from "./useWorkspaceOperations";
import { DEFAULT_HISTORY_VIEW, type HistoryViewState } from "../historyView";
import { useServiceRecovery, type RecoveryService } from "./useServiceRecovery";
import type {
  AppSettings,
  CaptureDiagnostics,
  DictationStatus,
  ExportFormat,
  HistoryBatchSnapshot,
  HistoryDeletionState,
  MagicStatus,
  MicrophoneDevice,
  Page,
  PasteLastStatus,
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
  const [captureDiagnostics, setCaptureDiagnostics] =
    useState<CaptureDiagnostics | null>(null);
  const [pasteLastStatus, setPasteLastStatus] = useState<PasteLastStatus>({
    phase: "idle",
    operationId: null,
    dueAt: null,
    remainingSeconds: 0,
    message: "",
  });
  const [captureProfile, setCaptureProfile] =
    useState<CaptureProfileSnapshot | null>(null);
  const [history, setHistory] = useState<TranscriptRecord[]>([]);
  // Session-only view state survives History navigation and page remounts.
  const [historyView, setHistoryView] =
    useState<HistoryViewState>(DEFAULT_HISTORY_VIEW);
  const [historyDeletion, setHistoryDeletion] =
    useState<HistoryDeletionState | null>(null);
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
  const serviceRecovery = useServiceRecovery({
    speech: setStatus,
    rewriting: setMagicStatus,
    shortcut: setShortcutStatus,
    platform: setCapabilities,
    updates: setUpdateStatus,
  });
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
      retainSessionTranscripts([
        record,
        ...items.filter((item) => item.id !== record.id),
      ]),
    );

  const operations = useWorkspaceOperations(receiveTranscript);

  useEffect(() => {
    let alive = true;
    const owner = { alive: true };
    lifecycle.current = owner;
    const isCurrent = () => alive && owner.alive;
    const startup = new AbortController();
    const liveRecords = new Map<string, TranscriptRecord>();
    let readingHistory = true;
    const received = new Set<string>();
    const startupAdded = new Map<string, TranscriptRecord>();
    const startupRemoved = new Set<string>();
    let initialized = false;
    const subscribe =
      <T>(name: string, receive: (value: T) => void) =>
      (value: T) => {
        if (!isCurrent()) return;
        received.add(name);
        const services: Record<string, RecoveryService> = {
          "speech status": "speech",
          "rewriting status": "rewriting",
          "shortcut status": "shortcut",
          "update status": "updates",
        };
        if (services[name]) serviceRecovery.received(services[name]);
        receive(value);
      };
    const read = <T>(name: string, request: () => Promise<T>) =>
      readStartupService(name, request, startup.signal);
    setStartupError(null);
    const recorder = new PcmRecorder((stats) => {
      if (alive) setCaptureDiagnostics(stats);
    });
    const receiveBatch = (snapshot: HistoryBatchSnapshot) => {
      if (!alive) return;
      received.add("history batch");
      received.add("transcript history");
      setHistory(retainSessionTranscripts(snapshot.records));
      setHistoryDeletion(snapshot.deletion);
    };
    const subscriptions = [
      bridge.onStatus(
        subscribe("speech status", (next: DictationStatus) => {
          setStatus(next);
          if (next.phase === "idle" || next.phase === "error")
            setCaptureProfile(null);
        }),
      ),
      bridge.onPasteLastStatus(subscribe("paste last", setPasteLastStatus)),
      bridge.onMagicStatus(subscribe("rewriting status", setMagicStatus)),
      bridge.onSettingsChanged(subscribe("settings", receiveSettings)),
      bridge.onNavigate((next) => {
        if (isCurrent()) setPage(next);
      }),
      bridge.onShortcutStatus(subscribe("shortcut status", setShortcutStatus)),
      bridge.onUpdateStatus(subscribe("update status", setUpdateStatus)),
      bridge.onRecorderCommand((command) => {
        if (!isCurrent()) return;
        if (command.action === "start")
          setCaptureProfile(command.captureProfile ?? null);
        if (command.action === "cancel") setCaptureProfile(null);
        void recorder.handle(command).catch((reason) => {
          if (isCurrent()) report(reason);
        });
      }),
      bridge.onTranscript((record) => {
        if (!isCurrent()) return;
        if (readingHistory) liveRecords.set(record.id, record);
        if (!initialized) startupAdded.set(record.id, record);
        receiveTranscript(record);
      }),
      bridge.onHistoryRetentionApplied((removedIds) => {
        if (!isCurrent()) return;
        const removed = new Set(removedIds);
        if (!initialized) for (const id of removed) startupRemoved.add(id);
        setHistory((items) =>
          items.filter((record) => !removed.has(record.id)),
        );
      }),
      bridge.onHistoryBatchChanged(receiveBatch),
    ];
    void bridge.recorderReady().catch((reason) => {
      if (isCurrent()) report(reason);
    });
    void bridge
      .getPasteLastStatus()
      .then((state) => {
        if (isCurrent() && !received.has("paste last"))
          setPasteLastStatus(state);
      })
      .catch((reason) => {
        if (isCurrent()) report(reason);
      });
    void Promise.allSettled([
      read("settings", () => bridge.getSettings()),
      read("speech status", () => bridge.getStatus()),
      read("rewriting status", () => bridge.getMagicStatus()),
      read("shortcut status", () => bridge.getShortcutStatus()),
      read("transcript history", () => bridge.getHistoryBatchSnapshot()),
      read("platform capabilities", () => bridge.getCapabilities()),
      read("update status", () => bridge.getUpdateStatus()),
    ])
      .then(([next, speech, magic, shortcut, records, platform, update]) => {
        if (!isCurrent()) return;
        readingHistory = false;
        if (next.status === "rejected" || records.status === "rejected") {
          liveRecords.clear();
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
        if (!received.has("history batch")) {
          const merged = new Map(
            records.value.records.map((record) => [record.id, record]),
          );
          for (const [id, record] of startupAdded) merged.set(id, record);
          setHistory(
            [...merged.values()]
              .filter((record) => !startupRemoved.has(record.id))
              .sort((a, b) => b.createdAt - a.createdAt),
          );
          setHistoryDeletion(records.value.deletion);
        }
        initialized = true;
        startupAdded.clear();
        startupRemoved.clear();
        if (!received.has("speech status")) {
          if (speech.status === "fulfilled") setStatus(speech.value);
          else {
            serviceRecovery.failed("speech", speech.reason);
            setStatus({
              phase: "error",
              engine: "error",
              message:
                "Could not read speech engine status. Retry speech status.",
            });
          }
        }
        if (!received.has("rewriting status")) {
          if (magic.status === "fulfilled") setMagicStatus(magic.value);
          else {
            serviceRecovery.failed("rewriting", magic.reason);
            setMagicStatus({
              phase: "error",
              engine: "error",
              message: "Rewriting is unavailable. Dictation can still be used.",
            });
          }
        }
        if (!received.has("shortcut status")) {
          if (shortcut.status === "fulfilled")
            setShortcutStatus(shortcut.value);
          else {
            serviceRecovery.failed("shortcut", shortcut.reason);
            setShortcutStatus((previous) => ({
              ...previous,
              registered: false,
              message: "Shortcut status is unavailable. Use the Record button.",
            }));
          }
        }
        if (platform.status === "fulfilled") setCapabilities(platform.value);
        else serviceRecovery.failed("platform", platform.reason);
        if (!received.has("update status")) {
          if (update.status === "fulfilled") setUpdateStatus(update.value);
          else {
            serviceRecovery.failed("updates", update.reason);
            setUpdateStatus((previous) => ({
              ...previous,
              phase: "error",
              message: "Could not read update status",
            }));
          }
        }
        setReady(true);
      })
      .catch((reason: unknown) => {
        if (isCurrent())
          setStartupError(
            reason instanceof Error ? reason.message : String(reason),
          );
      });
    return () => {
      alive = false;
      owner.alive = false;
      startup.abort();
      serviceRecovery.cancel();
      subscriptions.forEach((remove) => remove());
      void recorder.cancel().catch(() => {
        /* The retired owner cannot publish an error. */
      });
    };
  }, [startupAttempt]);

  useEffect(() => {
    let alive = true;
    let revision = 0;
    const refresh = () => {
      const current = ++revision;
      void listMicrophones(false)
        .then((next) => {
          if (alive && current === revision) setDevices(next);
        })
        .catch((reason: unknown) => {
          if (alive && current === revision) {
            setDevices([
              {
                deviceId: "default",
                label: "System default",
                labelKnown: false,
              },
            ]);
            report(reason);
          }
        });
    };
    refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener("devicechange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);

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

  function managePersonalProfile(
    command: PersonalProfileCommand,
  ): Promise<boolean> {
    const verb =
      command.action === "delete"
        ? "deleted"
        : command.action === "rename"
          ? "renamed"
          : "saved";
    return action(async () => {
      receiveSettings(await bridge.managePersonalProfile(command));
    }, `Profile ${verb} · active settings unchanged`);
  }

  function activateProfile(
    command: ProfileActivationCommand,
  ): Promise<boolean> {
    return action(
      async () =>
        receiveSettings(await bridge.activatePersonalProfile(command)),
      "Profile switched",
    );
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
          retainSessionTranscripts(
            items.map((item) => (item.id === id ? updated : item)),
          ),
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
    void action(async () => {
      await bridge.pasteLastTranscript();
    });
  };
  const exportSelection = (ids: string[], format: ExportFormat) =>
    action(async () => {
      const path = await bridge.exportHistorySelection(ids, format);
      if (path) setToast(`Exported ${ids.length} transcripts`);
    });
  const deleteSelection = (ids: string[]) =>
    action(async () => {
      await bridge.stageHistoryDeletion(ids);
    });
  const undoDeletion = (token: string) =>
    action(() => bridge.undoHistoryDeletion(token), "Deletion undone");
  return {
    operations,
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
    captureDiagnostics,
    historyDeletion,
    exportSelection,
    deleteSelection,
    undoDeletion,
    captureProfile,
    setHistory,
    historyView,
    setHistoryView,
    devices,
    capabilities,
    updateStatus,
    serviceRecovery,
    saving,
    toast,
    setToast,
    error,
    setError,
    action,
    saveSettings,
    managePersonalProfile,
    activateProfile,
    updateTranscript,
    finishOnboarding,
    copy,
    pasteLast,
    pasteLastStatus,
    cancelPasteLast: () => {
      if (pasteLastStatus.operationId)
        void action(async () => {
          await bridge.cancelPasteLast(pasteLastStatus.operationId!);
        });
    },
    receiveTranscript,
  };
}
