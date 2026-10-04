import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  session,
  shell,
  Tray,
} from "electron";
import type { MenuItemConstructorOptions } from "electron";
import electronUpdater from "electron-updater";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  HistoryBatchDeletion,
  historySelection,
} from "./services/historyBatch";
import { join, resolve } from "node:path";
import type {
  AppSettings,
  MagicPreset,
  Page,
  PasteRecovery,
  TranscriptRecord,
} from "../src/types";
import { normalizeTimings } from "../src/pipelineTimings";
import { REWRITE_PRESETS } from "../src/rewritePresets";
import { assertPersonalProfilesUpdate } from "../src/personalProfiles";
import { DomainError } from "../src/domainErrors";
import { deliveredText } from "../src/transcriptText";
import { rememberSessionTranscript } from "../src/sessionTranscriptRetention";
import { SerialQueue } from "./runtime/serialQueue";
import { AsrService } from "./services/asr";
import { ModelCacheService } from "./services/modelCache";
import { DictationService } from "./services/dictation";
import { PasteService } from "./services/paste";
import { RuleUsageService } from "./services/ruleUsage";
import { PasteLastService } from "./services/pasteLast";
import { PillService } from "./services/pill";
import { ShortcutService } from "./services/shortcut";
import { normalizeSettings, StorageService } from "./services/storage";
import {
  createIndicatorAdapter,
  createPasteAdapter,
  createShortcutAdapter,
  type DesktopIndicatorAdapter,
  type DesktopPasteAdapter,
  type DesktopShortcutAdapter,
} from "./services/desktopAdapters";
import { recoverTemporaryAudio } from "./services/audioCacheRecovery";
import { deletedDespiteCleanup } from "./services/migrationBackups";
import { UpdateService } from "./services/updates";
import { setLinuxAutostart } from "./services/autostart";
import { linuxTrayHostAvailable } from "./services/trayHost";
import {
  menuPreview,
  trayState,
  type TrayIconState,
} from "./services/trayState";
import { registerMainIpc } from "./ipc";

const { autoUpdater } = electronUpdater;

if (
  process.platform === "linux" &&
  process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland"
) {
  // ASR CUDA runs in Python and is unaffected by Chromium's compositor.
  app.commandLine.appendSwitch("disable-gpu");
}
app.setName(app.isPackaged ? "Delulu Talks" : "Delulu Talks Dev");
if (process.platform === "linux")
  app.setDesktopName(
    app.isPackaged ? "delulu-talks.desktop" : "delulu-talks-dev.desktop",
  );
if (!app.isPackaged || process.env.DELULU_USER_DATA_DIR)
  app.setPath(
    "userData",
    process.env.DELULU_USER_DATA_DIR
      ? resolve(process.env.DELULU_USER_DATA_DIR)
      : join(app.getPath("appData"), "Delulu Talks Dev"),
  );

const smokeTest =
  process.env.DELULU_SMOKE_TEST === "1" &&
  (!app.isPackaged || !!process.env.DELULU_USER_DATA_DIR);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** Launch-at-login starts in the tray; any explicit reopen shows the window. */
const startHidden = process.argv.includes("--hidden");
/** False on Linux desktops with no StatusNotifier host, where a tray is invisible. */
let trayVisible = true;
let hiddenNoticeShown = false;
let quitting = false;
let storage: StorageService;

let asr: AsrService;
let modelCache: ModelCacheService;

let paste: DesktopPasteAdapter;
let pasteLast: PasteLastService;
let pill: DesktopIndicatorAdapter;
let dictation: DictationService;
let labIpc: ReturnType<typeof registerMainIpc> | null = null;
let ruleUsage: RuleUsageService;

let shortcut: DesktopShortcutAdapter;
let updates: UpdateService;
const settingsQueue = new SerialQueue();
let lastTranscript: TranscriptRecord | null = null;
const sessionTranscripts = new Map<string, TranscriptRecord>();
let pasteRecovery: PasteRecovery | null = null;
const historyDeletion = new HistoryBatchDeletion(
  (ids) => {
    // Publish the durable snapshot before invalidating any session records.
    const cleanupFailure = deletedDespiteCleanup(() =>
      storage.deleteHistorySelection(ids),
    );
    for (const id of ids) sessionTranscripts.delete(id);
    if (lastTranscript && ids.includes(lastTranscript.id))
      lastTranscript = null;
    if (pasteRecovery && ids.includes(pasteRecovery.transcriptId))
      setPasteRecovery(null);
    if (cleanupFailure) throw cleanupFailure;
  },
  () => {
    const state = historyDeletion.getState();
    storage.pinHistory(state?.phase === "pending" ? state.ids : []);
    broadcast("history:batchChanged", historyBatchSnapshot());
    rebuildTrayMenu();
  },
);
const selectedAudioFiles = new Set<string>();

function setPasteRecovery(recovery: PasteRecovery | null): void {
  pasteRecovery = recovery;
  broadcast("paste:recoveryChanged", recovery);
}

function visibleHistory(): TranscriptRecord[] {
  const records = new Map(
    storage.getHistory().map((record) => [record.id, record]),
  );
  // Saved records are authoritative on disk; the session map only adds unsaved ones.
  for (const [id, record] of sessionTranscripts)
    if (record.sessionOnly && !records.has(id)) records.set(id, record);
  return [...records.values()]
    .filter((record) => !historyDeletion.hidden(record.id))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function historyBatchSnapshot() {
  return { deletion: historyDeletion.getState(), records: visibleHistory() };
}

function selectedHistory(ids: string[]): TranscriptRecord[] {
  return ids.map((id) => {
    if (historyDeletion.hidden(id))
      throw new Error("Undo deletion before using this transcript.");
    const record = storage.findHistory(id) ?? sessionTranscripts.get(id);
    if (!record)
      throw new Error(
        "A selected transcript is no longer available. Select the records again.",
      );
    return record;
  });
}

function preloadPath(): string {
  return join(__dirname, "../preload/preload.cjs");
}

function loadRenderer(
  window: BrowserWindow,
  query?: Record<string, string>,
): void {
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    for (const [key, value] of Object.entries(query ?? {}))
      url.searchParams.set(key, value);
    void window.loadURL(url.toString());
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"), { query });
  }
}

function broadcast(channel: string, value: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send(channel, value);
}

function menuBarOnlyActive(): boolean {
  return (
    process.platform === "darwin" &&
    !smokeTest &&
    !!tray &&
    storage.getSettings().menuBarOnly
  );
}

function syncMacDock(): void {
  if (process.platform !== "darwin" || smokeTest || !app.dock) return;
  if (menuBarOnlyActive()) app.dock.hide();
  else
    void app.dock.show().catch(() => {
      broadcast(
        "app:message",
        "Could not show the Dock icon. Use the menu bar to reopen Delulu Talks.",
      );
    });
}

/** Matches the renderer canvas so the first frame never flashes the wrong theme. */
function windowBackground(): string {
  const theme = storage?.getSettings().theme ?? "system";
  const dark =
    theme === "dark" || (theme === "system" && nativeTheme.shouldUseDarkColors);
  return dark ? "#031424" : "#cfeaf4";
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: "Delulu Talks",
    icon: iconPath(),
    width: 800,
    height: 620,
    minWidth: 480,
    minHeight: 420,
    center: true,
    show: false,
    backgroundColor: windowBackground(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const reveal = () => {
    // Keep the renderer alive for capture, but require an installed tray before
    // suppressing startup visibility. Explicit reopen actions still show it.
    if (menuBarOnlyActive() || (startHidden && !!tray && trayVisible)) return;
    if (!window.isDestroyed() && !window.isVisible()) window.show();
  };
  window.once("ready-to-show", reveal);
  // Some packaged Linux/Wayland builds never emit ready-to-show even though the
  // renderer is ready. did-finish-load keeps first launch from becoming a
  // tray-only app with no visible onboarding window.
  window.webContents.once("did-finish-load", reveal);
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(
      "Delulu Talks renderer stopped:",
      details.reason,
      details.exitCode,
    );
    // The renderer owns the microphone: end any capture it was running and
    // bring the workspace back instead of leaving dictation stuck.
    dictation?.recorderUnavailable();
    if (!quitting && details.reason !== "clean-exit" && !window.isDestroyed())
      window.webContents.reload();
  });
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
    if (!trayVisible && !hiddenNoticeShown) {
      hiddenNoticeShown = true;
      notify(
        "Delulu Talks is still running, so your shortcut keeps working. Open it again from your app launcher.",
      );
    }
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  loadRenderer(window);
  return window;
}

function iconPath(): string {
  const packaged = join(process.resourcesPath, "icon.png");
  return app.isPackaged && existsSync(packaged)
    ? packaged
    : resolve(app.getAppPath(), "build", "icon.png");
}

function showMainWindow(page?: Page): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (!page) return;
  const navigate = () => broadcast("app:navigate", page);
  if (mainWindow.webContents.isLoadingMainFrame())
    mainWindow.webContents.once("did-finish-load", navigate);
  else navigate();
}

function engineLabel(status: {
  engine: ReturnType<AsrService["getStatus"]>["engine"];
  migrationRequired?: boolean;
}): string {
  if (status.engine === "missing" && status.migrationRequired)
    return "Update runtime";
  return {
    missing: "Setup needed",
    unloaded: "Model not loaded",
    settingUp: "Installing…",
    loading: "Loading…",
    ready: "Ready",
    error: "Needs attention",
  }[status.engine];
}

type TrayActionScope = "speech" | "rewrite" | "app";

/**
 * Model actions report through their engine status. Everything else (settings,
 * updates, paste) is shown as a notification, so a refused tray click never
 * marks the speech engine broken and blocks dictation.
 */
function runTrayAction(
  action: () => unknown | Promise<unknown>,
  scope: TrayActionScope = "app",
): void {
  void Promise.resolve()
    .then(action)
    .catch((error) => {
      if (scope === "speech") asr.fail(error);
      else if (scope === "rewrite") asr.failMagic(error);
      else notify(error instanceof Error ? error.message : String(error));
      rebuildTrayMenu();
    });
}

function notify(body: string): void {
  if (smokeTest) return;
  if (Notification.isSupported())
    new Notification({ title: "Delulu Talks", body, silent: true }).show();
  else console.error(body);
}

function patchTraySettings(patch: Partial<AppSettings>): void {
  runTrayAction(() => persistSettings(patch));
}

function speechMenu(settings: AppSettings): MenuItemConstructorOptions[] {
  const speech = asr.getStatus();
  const busy =
    dictation.isActive ||
    ["preparing", "loading", "transcribing"].includes(speech.phase);
  const action: MenuItemConstructorOptions =
    speech.engine === "ready"
      ? {
          label: "Unload model",
          enabled: !busy,
          click: () => runTrayAction(() => asr.unload(), "speech"),
        }
      : speech.engine === "unloaded"
        ? {
            label: "Load model now",
            enabled: !busy,
            click: () =>
              runTrayAction(
                () => asr.loadModel(storage.getSettings()),
                "speech",
              ),
          }
        : {
            label: speech.migrationRequired
              ? "Update speech runtime…"
              : "Set up speech…",
            enabled: !busy,
            click: () => showMainWindow("models"),
          };
  const engines: MenuItemConstructorOptions[] =
    process.platform === "darwin"
      ? []
      : [
          ...(
            [
              ["r2t2", "R2T2 — most accurate"],
              ["nemotron", "Nemotron 3.5 — light, word by word"],
            ] as const
          ).map(([engine, label]): MenuItemConstructorOptions => ({
            type: "radio",
            label,
            checked: settings.speechEngine === engine,
            enabled: !busy,
            click: () =>
              settings.speechEngine !== engine &&
              patchTraySettings({ speechEngine: engine }),
          })),
          ...(settings.speechEngine === "nemotron"
            ? [
                {
                  type: "checkbox" as const,
                  label: "Run on CPU only",
                  checked: settings.speechDevice === "cpu",
                  enabled: !busy,
                  click: () =>
                    patchTraySettings({
                      speechDevice:
                        settings.speechDevice === "cpu" ? "auto" : "cpu",
                    }),
                },
              ]
            : []),
          { type: "separator" },
        ];
  return [
    { label: engineLabel(speech), enabled: false },
    ...engines,
    {
      type: "checkbox",
      label: "Type live while speaking",
      checked: settings.liveTyping,
      click: () => patchTraySettings({ liveTyping: !settings.liveTyping }),
    },
    {
      type: "checkbox",
      label: "Keep model ready",
      checked: settings.preloadModel,
      click: () => patchTraySettings({ preloadModel: !settings.preloadModel }),
    },
    action,
  ];
}

function rewriteMenu(settings: AppSettings): MenuItemConstructorOptions[] {
  const magic = asr.getMagicStatus();
  const busy = ["preparing", "loading", "rewriting"].includes(magic.phase);
  const action: MenuItemConstructorOptions =
    magic.engine === "ready"
      ? {
          label: "Unload model",
          enabled: !busy,
          click: () => runTrayAction(() => asr.unloadMagic(), "rewrite"),
        }
      : magic.engine === "unloaded"
        ? {
            label: "Load model now",
            enabled: !busy,
            click: () =>
              runTrayAction(
                () => asr.loadMagic(storage.getSettings()),
                "rewrite",
              ),
          }
        : {
            label: "Set up rewriting…",
            enabled: !busy,
            click: () => showMainWindow("models"),
          };
  return [
    {
      type: "radio",
      label: "Off",
      checked: !settings.magicEnabled,
      click: () => patchTraySettings({ magicEnabled: false }),
    },
    ...REWRITE_PRESETS.map(({ id, label }): MenuItemConstructorOptions => ({
      type: "radio",
      label,
      checked: settings.magicEnabled && settings.magicPreset === id,
      click: () =>
        patchTraySettings({
          magicEnabled: true,
          magicPreset: id as AppSettings["magicPreset"],
          ...(id === "spoken-corrections"
            ? { magicAllowInferences: false }
            : {}),
        }),
    })),
    { type: "separator" },
    {
      type: "checkbox",
      label: "Allow helpful assumptions",
      checked: settings.magicAllowInferences,
      enabled: settings.magicPreset !== "spoken-corrections",
      click: () =>
        patchTraySettings({
          magicAllowInferences: !settings.magicAllowInferences,
        }),
    },
    {
      type: "checkbox",
      label: "Keep model ready",
      checked: settings.preloadMagicModel,
      click: () =>
        patchTraySettings({ preloadMagicModel: !settings.preloadMagicModel }),
    },
    { label: `Model: ${engineLabel(magic)}`, enabled: false },
    action,
  ];
}

function recordDelivery(
  record: TranscriptRecord,
  state: NonNullable<TranscriptRecord["delivery"]>["state"],
  detail?: string,
  method?: string,
): void {
  const saved = storage.findHistory(record.id);
  const current = saved ?? sessionTranscripts.get(record.id);
  if (!current) return;
  const updated = {
    ...current,
    delivery: { state, updatedAt: Date.now(), detail, method },
  };
  if (saved) storage.replaceHistory(updated);
  rememberSessionTranscript(
    sessionTranscripts,
    updated,
    historyDeletion.getState()?.ids ?? [],
  );
  if (lastTranscript?.id === record.id) lastTranscript = updated;
  broadcast("history:added", updated);
  rebuildTrayMenu();
}

function schedulePasteLast() {
  const record = lastTranscript
    ? (storage.findHistory(lastTranscript.id) ??
      sessionTranscripts.get(lastTranscript.id))
    : storage.getHistory()[0];
  if (!record) throw new Error("Record something first");
  return pasteLast.start(
    record.id,
    deliveredText(record),
    storage.getSettings().pasteLastDelaySeconds,
  );
}

let trayRebuild: ReturnType<typeof setTimeout> | null = null;
let trayMenuKey = "";
let trayIconState: TrayIconState | null = null;

/** Coalesces bursts (download progress, countdowns) into one menu update. */
function rebuildTrayMenu(): void {
  if (!tray || trayRebuild) return;
  trayRebuild = setTimeout(() => {
    trayRebuild = null;
    renderTrayMenu();
  }, 80);
}

function updateMenuItem(): MenuItemConstructorOptions {
  const update = updates?.getStatus();
  if (!update || update.phase === "unsupported")
    return {
      label: "Get updates on GitHub…",
      click: () =>
        void shell.openExternal(
          "https://github.com/JEMostert/delulu-talks/releases/latest",
        ),
    };
  const version = update.version ? ` ${update.version}` : "";
  switch (update.phase) {
    case "checking":
      return { label: "Checking for updates…", enabled: false };
    case "available":
      return {
        label: `Download update${version}`,
        click: () => runTrayAction(() => updates.download()),
      };
    case "downloading":
      return {
        label: `Downloading update · ${Math.round(update.percent ?? 0)}%`,
        enabled: false,
      };
    case "downloaded":
      return updates.installable()
        ? {
            label: `Restart to update${version}`,
            click: () => runTrayAction(() => updates.install()),
          }
        : { label: "Update ready — finish your current task", enabled: false };
    case "upToDate":
      return {
        label: `Up to date (${update.currentVersion})`,
        click: () => runTrayAction(() => updates.check()),
      };
    case "error":
      return {
        label: "Update failed — try again",
        click: () => runTrayAction(() => updates.check()),
      };
    default:
      return {
        label: "Check for updates",
        click: () => runTrayAction(() => updates.check()),
      };
  }
}

function renderTrayMenu(): void {
  if (!tray) return;
  const settings = storage.getSettings();
  const status = asr.getStatus();
  const magic = asr.getMagicStatus();
  const latest = visibleHistory()[0];
  const listening = status.phase === "listening" || status.phase === "paused";
  const dictationBusy = ["preparing", "loading", "transcribing"].includes(
    status.phase,
  );
  const speechUnavailable =
    status.engine === "missing" || status.engine === "error";
  const shortcutStatus = shortcut?.getStatus();
  const pending = pasteLast?.getStatus();
  const state = trayState({
    speech: status,
    rewrite: magic,
    shortcut: shortcutStatus,
    update: updates?.getStatus(),
    delivering: paste?.isBusy,
  });
  const shortcutHint =
    process.platform === "darwin" || !shortcutStatus?.registered
      ? ""
      : ` (${shortcutStatus.accelerator})`;
  const recent = visibleHistory().slice(0, 5);
  const template: MenuItemConstructorOptions[] = [
    { label: state.statusLine, enabled: false },
    { type: "separator" },
    listening
      ? {
          label: "Stop & transcribe",
          click: () => runTrayAction(() => dictation.toggle()),
        }
      : speechUnavailable
        ? {
            label: status.migrationRequired
              ? "Update speech runtime…"
              : "Set up speech…",
            click: () => showMainWindow("models"),
          }
        : {
            label: `Start dictation${shortcutHint}`,
            enabled: !dictationBusy,
            click: () => runTrayAction(() => dictation.toggle()),
          },
    ...(listening
      ? ([
          {
            label: status.phase === "paused" ? "Resume" : "Pause",
            click: () =>
              runTrayAction(() =>
                status.phase === "paused"
                  ? dictation.resume()
                  : dictation.pause(),
              ),
          },
          {
            label: "Cancel recording",
            click: () => runTrayAction(() => dictation.cancel()),
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    { type: "separator" },
    {
      label: latest
        ? `Copy “${menuPreview(deliveredText(latest))}”`
        : "Copy latest result",
      enabled: Boolean(latest),
      click: () => {
        if (!latest) return;
        paste.copy(deliveredText(latest));
        recordDelivery(latest, "copied");
      },
    },
    {
      label: "Recent",
      enabled: recent.length > 1,
      submenu: [
        ...recent.slice(1).map((record): MenuItemConstructorOptions => ({
          label: menuPreview(deliveredText(record), 48),
          click: () => {
            paste.copy(deliveredText(record));
            recordDelivery(record, "copied");
          },
        })),
        { type: "separator" },
        { label: "Open history", click: () => showMainWindow("history") },
      ],
    },
    pending?.phase === "pending"
      ? {
          label: `Cancel scheduled paste (${pending.remainingSeconds}s)`,
          click: () =>
            pasteLast.cancelPending("Scheduled paste cancelled from the tray."),
        }
      : {
          label: `Paste latest in ${settings.pasteLastDelaySeconds}s`,
          enabled:
            Boolean(latest) &&
            !dictation.isActive &&
            pending?.phase !== "delivering",
          click: () => runTrayAction(async () => void schedulePasteLast()),
        },
    { type: "separator" },
    { label: "Speech", submenu: speechMenu(settings) },
    {
      label: settings.magicEnabled
        ? `Rewriting: ${REWRITE_PRESETS.find((preset) => preset.id === settings.magicPreset)?.label ?? "On"}`
        : "Rewriting: Off",
      submenu: rewriteMenu(settings),
    },
    {
      label: "Preferences",
      submenu: [
        {
          type: "checkbox",
          label: "Paste automatically",
          checked: settings.autoPaste,
          click: () => patchTraySettings({ autoPaste: !settings.autoPaste }),
        },
        {
          type: "checkbox",
          label: "Keep a clipboard copy",
          checked: settings.copyToClipboard,
          click: () =>
            patchTraySettings({ copyToClipboard: !settings.copyToClipboard }),
        },
        {
          type: "checkbox",
          label: "Show recording pill",
          checked: settings.showOverlay,
          click: () =>
            patchTraySettings({ showOverlay: !settings.showOverlay }),
        },
        {
          type: "checkbox",
          label: "Save local history",
          checked: settings.keepHistory,
          click: () =>
            patchTraySettings({ keepHistory: !settings.keepHistory }),
        },
        { type: "separator" },
        {
          type: "checkbox",
          label: "Launch at login",
          checked: settings.launchAtLogin,
          click: () =>
            patchTraySettings({ launchAtLogin: !settings.launchAtLogin }),
        },
        ...(process.platform === "darwin"
          ? [
              {
                type: "checkbox" as const,
                label: "Menu bar only (hide Dock icon)",
                checked: settings.menuBarOnly,
                click: () =>
                  patchTraySettings({ menuBarOnly: !settings.menuBarOnly }),
              },
            ]
          : []),
        ...(shortcutStatus?.method === "portal"
          ? [
              {
                label: "Change shortcut…",
                click: () => runTrayAction(() => shortcut.configure()),
              },
            ]
          : []),
      ],
    },
    { type: "separator" },
    { label: "Open Delulu Talks", click: () => showMainWindow() },
    {
      label: "Go to",
      submenu: [
        { label: "History", click: () => showMainWindow("history") },
        { label: "Audio files", click: () => showMainWindow("lab") },
        {
          label: "Personalization",
          click: () => showMainWindow("vocabulary"),
        },
        { label: "Models", click: () => showMainWindow("models") },
        { label: "Settings", click: () => showMainWindow("settings") },
      ],
    },
    { type: "separator" },
    updateMenuItem(),
    {
      label: "Quit Delulu Talks",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ];
  // Rebuilding resends the whole menu over D-Bus on Linux; skip no-op updates
  // so an open menu does not flicker.
  const key = `${latest?.id ?? ""}:${JSON.stringify(template)}`;
  if (key !== trayMenuKey) {
    trayMenuKey = key;
    tray.setContextMenu(Menu.buildFromTemplate(template));
  }
  tray.setToolTip(state.tooltip);
  if (state.icon !== trayIconState) {
    trayIconState = state.icon;
    tray.setImage(trayImage(state.icon));
  }
}

const trayImages = new Map<TrayIconState, Electron.NativeImage>();

function trayImage(state: TrayIconState): Electron.NativeImage {
  const cached = trayImages.get(state);
  if (cached) return cached;
  const filename =
    process.platform === "darwin"
      ? `tray-${state}Template.png`
      : process.platform === "win32"
        ? `tray-${state}.ico`
        : `tray-${state}.png`;
  const path = app.isPackaged
    ? join(process.resourcesPath, "tray", filename)
    : resolve(app.getAppPath(), "build", "tray", filename);
  // createFromPath loads the @2x companion for HiDPI panels automatically.
  const image = nativeImage.createFromPath(path);
  if (process.platform === "darwin") image.setTemplateImage(true);
  trayImages.set(state, image);
  return image;
}

function installTray(): void {
  tray = new Tray(trayImage("idle"));
  trayIconState = "idle";
  renderTrayMenu();
  // On macOS a click opens the menu; also opening the window would steal
  // focus from the app the user wants to dictate into.
  if (process.platform !== "darwin") tray.on("click", () => showMainWindow());
  syncMacDock();
}

function ensureDevelopmentDesktopEntry(): void {
  if (process.platform !== "linux" || app.isPackaged) return;
  const dataHome =
    process.env.XDG_DATA_HOME || join(app.getPath("home"), ".local", "share");
  const applicationsDirectory = join(dataHome, "applications");
  const desktopPath = join(applicationsDirectory, "delulu-talks-dev.desktop");
  const quote = (value: string) =>
    `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const entry = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Delulu Talks Dev",
    `Exec=env -u ELECTRON_RUN_AS_NODE ${quote(process.execPath)} ${quote(app.getAppPath())}`,
    `Icon=${resolve(app.getAppPath(), "build", "icon.png")}`,
    "Terminal=false",
    "NoDisplay=true",
    "Categories=AudioVideo;Utility;",
    "StartupWMClass=delulu-talks",
    "",
  ].join("\n");
  mkdirSync(applicationsDirectory, { recursive: true });
  writeFileSync(desktopPath, entry, { encoding: "utf8", mode: 0o644 });
}

function setupPermissions(): void {
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission) =>
      contents === mainWindow?.webContents && permission === "media",
  );
  session.defaultSession.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      const mediaTypes = "mediaTypes" in details ? details.mediaTypes : [];
      const audioOnly =
        permission === "media" &&
        (!mediaTypes?.length ||
          mediaTypes.every((type: string) => type === "audio"));
      callback(contents === mainWindow?.webContents && audioOnly);
    },
  );
}

function validateText(value: unknown, max: number): string {
  if (typeof value !== "string") throw new Error("Expected text input");
  return value.slice(0, max);
}

function persistSettings(value: unknown): Promise<AppSettings> {
  return settingsQueue.run(() => applySettings(value));
}

async function applySettings(
  value: unknown,
  explicitProfileActivation = false,
): Promise<AppSettings> {
  const previous = storage.getSettings();
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a settings object");
  if (
    !explicitProfileActivation &&
    Object.prototype.hasOwnProperty.call(value, "activePersonalProfile") &&
    JSON.stringify((value as Record<string, unknown>).activePersonalProfile) !==
      JSON.stringify(previous.activePersonalProfile)
  ) {
    throw new Error("Switch profiles using the explicit activation preview.");
  }
  assertPersonalProfilesUpdate(
    previous.personalProfiles,
    Object.prototype.hasOwnProperty.call(value, "personalProfiles")
      ? (value as Record<string, unknown>).personalProfiles
      : previous.personalProfiles,
  );
  const next = normalizeSettings({ ...previous, ...value });
  const runtimeChanged =
    next.model !== previous.model ||
    next.speechEngine !== previous.speechEngine ||
    next.speechDevice !== previous.speechDevice;
  const magicRuntimeChanged = next.magicModel !== previous.magicModel;
  const assertEngineChangeIdle = () => {
    if (
      (runtimeChanged ||
        magicRuntimeChanged ||
        next.memoryPolicy !== previous.memoryPolicy ||
        next.magicEnabled !== previous.magicEnabled) &&
      (dictation.isActive || asr.isBusy)
    )
      throw new Error(
        "Finish the current recording or model operation before changing models",
      );
  };
  assertEngineChangeIdle();
  const persist = () => {
    // Portal registration can await permission while capture/inference starts.
    // Revalidate before the write, so the transaction restores the old shortcut.
    assertEngineChangeIdle();
    return storage.updateSettings(next);
  };
  const saved =
    next.shortcut !== previous.shortcut
      ? await shortcut.change(next.shortcut, previous.shortcut, persist)
      : persist();
  if (saved.menuBarOnly !== previous.menuBarOnly) syncMacDock();
  if (saved.launchAtLogin !== previous.launchAtLogin)
    syncLoginItem(saved.launchAtLogin);
  if (runtimeChanged) await asr.unload();
  if (magicRuntimeChanged) await asr.unloadMagic();
  const residencyChanged =
    next.preloadModel !== previous.preloadModel ||
    next.preloadMagicModel !== previous.preloadMagicModel ||
    next.magicEnabled !== previous.magicEnabled ||
    next.modelIdleMinutes !== previous.modelIdleMinutes ||
    next.memoryPolicy !== previous.memoryPolicy;
  if (runtimeChanged || magicRuntimeChanged || residencyChanged)
    asr.configureResidency(saved);
  if (saved.showOverlay !== previous.showOverlay) {
    if (saved.showOverlay) pill.prepare();
    dictation.syncOverlay();
  }
  broadcast("settings:changed", saved);
  rebuildTrayMenu();
  return saved;
}

function syncLoginItem(enabled: boolean): void {
  if (smokeTest || !app.isPackaged) return;
  try {
    if (process.platform === "linux") setLinuxAutostart(enabled);
    else
      app.setLoginItemSettings({
        openAtLogin: enabled,
        args: process.platform === "win32" ? ["--hidden"] : undefined,
      });
  } catch (error) {
    notify(
      `Could not change launch at login: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertRuntimeIdle(): void {
  if (dictation.isActive || asr.isBusy)
    throw new DomainError(
      "BUSY",
      "Finish the current recording or model operation first",
      {
        operationId: randomUUID(),
        operation: "runtime:idle",
      },
    );
}

async function start(): Promise<void> {
  if (!smokeTest) ensureDevelopmentDesktopEntry();
  storage = new StorageService();
  storage.enforceHistoryLimit();
  ruleUsage = new RuleUsageService(storage.dataDirectory);
  modelCache = new ModelCacheService(storage.modelCacheDirectory);
  // start() is entered only by the instance holding the user-data singleton lock.
  // No new worker/capture/import exists while prior-session generated WAVs are inspected.
  const audioRecovery = await recoverTemporaryAudio(storage.cacheDirectory);
  if (audioRecovery.failureCount) {
    const detail = `${audioRecovery.failureCount} temporary-audio cleanup failure(s). Some prior-session audio may remain on disk.\n\n${audioRecovery.failures.join("\n")}\n\nClose Delulu before inspecting the audio-cache directory in its local data folder. Only remove generated dictation/import WAVs you recognise. Your saved history, settings, source media, models and runtimes were not removed by this cleanup.`;
    console.error("Temporary audio cleanup incomplete:", detail);
    dialog.showErrorBox("Temporary audio cleanup needs attention", detail);
  }
  paste = createPasteAdapter(
    () => storage.getSettings().pastePortalToken || null,
    (pastePortalToken) => {
      const saved = storage.updateSettings({
        ...storage.getSettings(),
        pastePortalToken,
      });
      broadcast("settings:changed", saved);
    },
    { getShortcut: () => storage.getSettings().pasteShortcut },
  );
  pill = createIndicatorAdapter(
    smokeTest ? { env: { ...process.env, XDG_SESSION_TYPE: "" } } : {},
  );
  if (!smokeTest && storage.getSettings().showOverlay) pill.prepare();
  asr = new AsrService(storage, () => !dictation?.isActive);
  updates = new UpdateService(
    app.isPackaged &&
      process.platform !== "darwin" &&
      (process.platform !== "linux" || !!process.env.APPIMAGE)
      ? autoUpdater
      : null,
    app.getVersion(),
    (status) => {
      broadcast("updates:statusChanged", status);
      rebuildTrayMenu();
    },
    () =>
      !dictation?.isActive &&
      !asr.isBusy &&
      !paste.isBusy &&
      !settingsQueue.busy,
    process.platform === "darwin"
      ? "This unsigned Mac build uses manual updates. Download the new DMG from Releases, quit Delulu, replace the app, and reopen it. Your settings and models are preserved."
      : undefined,
  );
  updates.start();
  mainWindow = createMainWindow();
  dictation = new DictationService(
    storage,
    asr,
    paste,
    { main: () => mainWindow, pill },
    (record: TranscriptRecord) => {
      // Delivery measurements may arrive after a user changes this transcript.
      const current =
        storage.findHistory(record.id) ?? sessionTranscripts.get(record.id);
      if (current) {
        if (deliveredText(current) !== deliveredText(record)) return;
        record = {
          ...current,
          timings: normalizeTimings({
            ...current.timings,
            ...(record.timings?.clipboardMs === undefined
              ? {}
              : { clipboardMs: record.timings.clipboardMs }),
            ...(record.timings?.pasteMs === undefined
              ? {}
              : { pasteMs: record.timings.pasteMs }),
          }),
        };
      }
      lastTranscript = record;
      rememberSessionTranscript(
        sessionTranscripts,
        record,
        historyDeletion.getState()?.ids ?? [],
      );
      broadcast("history:added", record);
      rebuildTrayMenu();
    },
    (transcriptId, detail) => {
      if (
        storage.findHistory(transcriptId) ||
        sessionTranscripts.has(transcriptId)
      )
        setPasteRecovery({ transcriptId, detail });
    },
    (counts) =>
      ruleUsage.record(
        counts,
        storage.getSettings().customWords.map((rule) => rule.id),
      ),
  );
  pasteLast = new PasteLastService({
    captureActive: () => dictation.isActive,
    currentText: (id) => {
      const record = storage.findHistory(id) ?? sessionTranscripts.get(id);
      return record ? deliveredText(record) : null;
    },
    paste: (text) => paste.paste(text),
    copy: (text) => paste.copy(text),
    clipboardOnly: () => paste.capabilities().pasteMethod === "clipboard-only",
    delivery: (id, state, detail, method) => {
      const record = storage.findHistory(id) ?? sessionTranscripts.get(id);
      if (record) recordDelivery(record, state, detail, method);
    },
    changed: (status) => {
      broadcast("dictation:pasteLastChanged", status);
      rebuildTrayMenu();
    },
  });
  mainWindow.webContents.on("did-start-loading", () => {
    pasteLast.cancelPending(
      "Scheduled paste cancelled because the workspace reloaded.",
    );
    dictation.recorderUnavailable();
  });
  shortcut = createShortcutAdapter(() => storage.getSettings().shortcutMode, {
    start: () => dictation.start(),
    stop: () => dictation.stop(),
    toggle: () => dictation.toggle(),
  });
  asr.onStatus((status) => {
    dictation.runtimeChanged();
    if (dictation.isActive)
      pasteLast.cancelPending("Paste cancelled because a recording started.");
    broadcast("runtime:statusChanged", status);
    rebuildTrayMenu();
  });
  asr.onMagicStatus((status) => {
    dictation.runtimeChanged();
    broadcast("magic:statusChanged", status);
    rebuildTrayMenu();
  });
  shortcut.onStatus((status) => {
    broadcast("shortcut:statusChanged", status);
    rebuildTrayMenu();
  });
  setupPermissions();
  labIpc = registerMainIpc({
    getMainWindow: () => mainWindow,
    storage,
    asr,
    paste,
    pill,
    dictation,
    shortcut,
    updates,
    persistSettings,
    settingsBusy: () => settingsQueue.busy,
    getLastTranscript: () => lastTranscript,
    setLastTranscript: (record) => {
      lastTranscript = record;
    },
    sessionTranscripts,
    rebuildTrayMenu,
    pasteLast,
    modelCache,
    ruleUsage,
    schedulePasteLast,
    getPasteRecovery: () => pasteRecovery,
    setPasteRecovery,
    applySettings,
    settingsQueue,
    broadcast,
    selectedAudioFiles,
    historyDeletion,
    visibleHistory,
    historyBatchSnapshot,
    selectedHistory,
  });
  if (!smokeTest) {
    if (app.isPackaged)
      void shortcut
        .register(storage.getSettings().shortcut)
        .catch(() => undefined);
    installTray();
    void linuxTrayHostAvailable().then((available) => {
      trayVisible = available;
      if (!available && startHidden) showMainWindow();
    });
  }
  const updateTimer = setTimeout(() => void updates.check(), 8_000);
  updateTimer.unref();
  // A tray app can run for weeks; check again every six hours.
  setInterval(() => void updates.check(), 6 * 60 * 60 * 1000).unref();
  syncLoginItem(storage.getSettings().launchAtLogin);
  await asr.initialize(storage.getSettings());
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  console.error(
    "Delulu Talks is already running; forwarding this launch to the existing instance.",
  );
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    // `--toggle-dictation` lets desktops without a shortcut portal bind the
    // app itself to a custom keyboard shortcut.
    if (argv.includes("--toggle-dictation") && dictation)
      runTrayAction(() => dictation.toggle());
    else showMainWindow();
  });
  if (process.platform === "win32")
    app.setAppUserModelId("com.joran.delulu-talks");
  if (app.isPackaged) installApplicationMenu();
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      const detail =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      console.error("Delulu Talks failed to start:", detail);
      dialog.showErrorBox("Delulu Talks failed to start", detail);
      app.quit();
    });
}

app.on("activate", () => showMainWindow());

/**
 * Production windows have no reload or developer-tools shortcuts: a reload
 * would abort a recording. macOS keeps the standard app and edit menus.
 */
function installApplicationMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      { role: "windowMenu" },
    ]),
  );
}
let shutdownComplete = false;
app.on("before-quit", (event) => {
  quitting = true;
  if (shutdownComplete) return;
  try {
    labIpc?.shutdown();
  } catch (error) {
    console.error("Could not save import queue during shutdown", error);
  }
  dictation?.releaseRetryAudio();
  pill?.shutdown();
  pasteLast?.shutdown();
  paste?.shutdown();
  void shortcut?.shutdown();
  tray?.destroy();
  tray = null;
  if (!asr) return;
  // Wait for model workers (and their GPU children) to exit, but never hang quit.
  event.preventDefault();
  void Promise.race([
    asr.shutdown().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 6_000)),
  ]).finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});
app.on("window-all-closed", () => {
  // Delulu Talks is tray-first and intentionally remains available.
});
