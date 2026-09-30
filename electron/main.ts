import { app, BrowserWindow, dialog, Menu, nativeImage, session, shell, Tray } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import electronUpdater from "electron-updater";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppSettings, MagicPreset, Page, PasteRecovery, TranscriptRecord } from "../src/types";
import { REWRITE_PRESETS } from "../src/rewritePresets";
import { assertPersonalProfilesUpdate } from "../src/personalProfiles";
import { deliveredText } from "../src/transcriptText";
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
import { recoverTemporaryAudio } from "./services/audioCacheRecovery";
import { UpdateService } from "./services/updates";
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
let quitting = false;
let storage: StorageService;
let asr: AsrService;
let modelCache: ModelCacheService;
let paste: PasteService;
let pasteLast: PasteLastService;
let pill: PillService;
let dictation: DictationService;
let ruleUsage: RuleUsageService;
let shortcut: ShortcutService;
let updates: UpdateService;
const settingsQueue = new SerialQueue();
let lastTranscript: TranscriptRecord | null = null;
const sessionTranscripts = new Map<string, TranscriptRecord>();
let pasteRecovery: PasteRecovery | null = null;

function setPasteRecovery(recovery: PasteRecovery | null): void {
  pasteRecovery = recovery;
  broadcast("paste:recoveryChanged", recovery);
}
const selectedAudioFiles = new Set<string>();

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

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: "Delulu Talks",
    icon: iconPath(),
    width: 1280,
    height: 780,
    minWidth: 820,
    minHeight: 650,
    center: true,
    show: false,
    backgroundColor: "#091c2d",
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
    if (menuBarOnlyActive()) return;
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
  });
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
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

function runTrayAction(
  action: () => unknown | Promise<unknown>,
  magic = false,
): void {
  void Promise.resolve()
    .then(action)
    .catch((error) => (magic ? asr.failMagic(error) : asr.fail(error)));
}

function patchTraySettings(patch: Partial<AppSettings>): void {
  runTrayAction(
    () => persistSettings(patch),
    "magicEnabled" in patch ||
      "magicPreset" in patch ||
      "magicAllowInferences" in patch ||
      "preloadMagicModel" in patch,
  );
}

function runtimeMenu(settings: AppSettings): MenuItemConstructorOptions[] {
  const speech = asr.getStatus();
  const magic = asr.getMagicStatus();
  const speechBusy = ["preparing", "loading", "transcribing"].includes(
    speech.phase,
  );
  const magicBusy = ["preparing", "loading", "rewriting"].includes(magic.phase);
  const speechAction: MenuItemConstructorOptions =
    speech.engine === "ready"
      ? {
          label: "Unload speech model",
          enabled: !speechBusy,
          click: () => runTrayAction(() => asr.unload()),
        }
      : speech.engine === "unloaded"
        ? {
            label: "Load speech model now",
            enabled: !speechBusy,
            click: () =>
              runTrayAction(() => asr.loadModel(storage.getSettings())),
          }
        : {
            label: speech.migrationRequired
              ? "Update speech runtime…"
              : "Set up speech runtime…",
            enabled: !speechBusy,
            click: () => showMainWindow("models"),
          };
  const magicAction: MenuItemConstructorOptions =
    magic.engine === "ready"
      ? {
          label: "Unload rewrite model",
          enabled: !magicBusy,
          click: () => runTrayAction(() => asr.unloadMagic(), true),
        }
      : magic.engine === "unloaded"
        ? {
            label: "Load rewrite model now",
            enabled: !magicBusy,
            click: () =>
              runTrayAction(() => asr.loadMagic(storage.getSettings()), true),
          }
        : {
            label: "Set up rewrite runtime…",
            enabled: !magicBusy,
            click: () => showMainWindow("models"),
          };

  return [
    {
      label: `Speech · ${engineLabel(speech)}`,
      sublabel: speech.message,
      enabled: false,
    },
    speechAction,
    {
      type: "checkbox",
      label: "Keep speech model ready",
      checked: settings.preloadModel,
      click: () => patchTraySettings({ preloadModel: !settings.preloadModel }),
    },
    { type: "separator" },
    {
      label: `Rewriting · ${engineLabel(magic)}`,
      sublabel: magic.message,
      enabled: false,
    },
    magicAction,
    {
      type: "checkbox",
      label: "Keep rewrite model ready",
      checked: settings.preloadMagicModel,
      click: () =>
        patchTraySettings({ preloadMagicModel: !settings.preloadMagicModel }),
    },
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
  sessionTranscripts.set(record.id, updated);
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

function rebuildTrayMenu(): void {
  if (!tray) return;
  const settings = storage.getSettings();
  const status = asr.getStatus();
  const magic = asr.getMagicStatus();
  const latest = lastTranscript
    ? (storage.findHistory(lastTranscript.id) ?? lastTranscript)
    : storage.getHistory()[0];
  const listening = status.phase === "listening";
  const dictationBusy = ["preparing", "loading", "transcribing"].includes(
    status.phase,
  );
  const update = updates?.getStatus();
  const speechUnavailable =
    status.engine === "missing" || status.engine === "error";
  const presets: Array<[MagicPreset, string]> = REWRITE_PRESETS.map(
    ({ id, label }) => [id, label],
  );
  const template: MenuItemConstructorOptions[] = [
    { label: "DELULU TALKS", enabled: false },
    {
      label: listening
        ? "■  Stop & transcribe"
        : dictationBusy
          ? `●  ${status.message}`
          : speechUnavailable
            ? "!  Speech setup needs attention…"
            : "●  Start dictation",
      sublabel: speechUnavailable
        ? status.message
        : `Shortcut: ${settings.shortcut}`,
      enabled: listening || !dictationBusy,
      click: () =>
        speechUnavailable ? showMainWindow("models") : dictation.toggle(),
    },
    { label: "Open Delulu Talks", click: () => showMainWindow("home") },
    {
      label: "Paste latest result",
      enabled:
        Boolean(latest) &&
        !dictation.isActive &&
        !["pending", "delivering"].includes(
          pasteLast?.getStatus().phase ?? "idle",
        ),
      click: () =>
        runTrayAction(async () => {
          schedulePasteLast();
        }),
    },
    {
      label:
        pasteLast?.getStatus().phase === "pending"
          ? `Cancel scheduled paste (${pasteLast.getStatus().remainingSeconds}s)`
          : "Cancel scheduled paste",
      enabled: pasteLast?.getStatus().phase === "pending",
      click: () =>
        pasteLast.cancelPending("Scheduled paste cancelled from the tray."),
    },
    {
      label: "Copy latest result",
      sublabel: latest
        ? deliveredText(latest).replace(/\s+/g, " ").slice(0, 72)
        : "Your most recent dictation appears here",
      enabled: Boolean(latest),
      click: () => {
        if (latest) {
          paste.copy(deliveredText(latest));
          recordDelivery(latest, "copied");
        }
      },
    },
    { type: "separator" },
    {
      type: "checkbox",
      label: "✦  Rewrite after dictation",
      checked: settings.magicEnabled,
      click: () => patchTraySettings({ magicEnabled: !settings.magicEnabled }),
    },
    {
      label: "Rewrite style",
      enabled: settings.magicEnabled,
      submenu: presets.map(([preset, label]) => ({
        type: "radio",
        label,
        checked: settings.magicPreset === preset,
        click: () => patchTraySettings({ magicPreset: preset }),
      })),
    },
    {
      type: "checkbox",
      label: "Allow helpful assumptions",
      checked: settings.magicAllowInferences,
      enabled: settings.magicEnabled,
      click: () =>
        patchTraySettings({
          magicAllowInferences: !settings.magicAllowInferences,
        }),
    },
    { type: "separator" },
    {
      label: "Delivery & capture",
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
      ],
    },
    { label: "Models & runtimes", submenu: runtimeMenu(settings) },
    {
      label: "Open workspace",
      submenu: [
        { label: "History", click: () => showMainWindow("history") },
        { label: "Models & runtimes", click: () => showMainWindow("models") },
        { label: "Settings", click: () => showMainWindow("settings") },
      ],
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
    update
      ? {
          label:
            update.phase === "downloaded"
              ? `Restart to install ${update.version}`
              : update.phase === "available"
                ? `Download update ${update.version}`
                : update.phase === "downloading"
                  ? `Downloading update · ${Math.round(update.percent ?? 0)}%`
                  : update.phase === "checking"
                    ? "Checking for updates…"
                    : "Check for updates",
          enabled:
            update.phase !== "checking" &&
            update.phase !== "downloading" &&
            update.phase !== "unsupported",
          click: () => {
            if (update.phase === "downloaded")
              runTrayAction(() => updates.install());
            else if (update.phase === "available")
              runTrayAction(() => updates.download());
            else runTrayAction(() => updates.check());
          },
        }
      : { label: "Check for updates", enabled: false },
    {
      label: "Quit Delulu Talks",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  const state = listening
    ? "Listening"
    : status.phase === "transcribing"
      ? "Transcribing"
      : status.engine === "ready"
        ? "Ready"
        : engineLabel(status);
  tray.setToolTip(
    `Delulu Talks — ${state}${settings.magicEnabled ? ` · Rewriting ${engineLabel(magic)}` : " · Rewriting off"}`,
  );
}

function installTray(): void {
  const filename =
    process.platform === "darwin" ? "trayTemplate.png" : "tray.png";
  const path = app.isPackaged
    ? join(process.resourcesPath, filename)
    : resolve(app.getAppPath(), "build", filename);
  const icon = nativeImage.createFromPath(path);
  if (process.platform === "darwin") icon.setTemplateImage(true);
  const trayIcon =
    process.platform === "darwin"
      ? icon
      : icon.resize({ width: 20, height: 20 });
  tray = new Tray(trayIcon);
  rebuildTrayMenu();
  tray.on("click", () => showMainWindow("home"));
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

async function applySettings(value: unknown, explicitProfileActivation = false): Promise<AppSettings> {
  const previous = storage.getSettings();
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a settings object");
  if (!explicitProfileActivation && Object.prototype.hasOwnProperty.call(value, "activePersonalProfile") &&
      JSON.stringify((value as Record<string, unknown>).activePersonalProfile) !== JSON.stringify(previous.activePersonalProfile)) {
    throw new Error("Switch profiles using the explicit activation preview.");
  }
  assertPersonalProfilesUpdate(
    previous.personalProfiles,
    Object.prototype.hasOwnProperty.call(value, "personalProfiles")
      ? (value as Record<string, unknown>).personalProfiles
      : previous.personalProfiles,
  );
  const next = normalizeSettings({ ...previous, ...value });
  const runtimeChanged = next.model !== previous.model;
  const magicRuntimeChanged = next.magicModel !== previous.magicModel;
  const assertEngineChangeIdle = () => {
    if (
      (runtimeChanged ||
        magicRuntimeChanged ||
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
  if (
    !smokeTest &&
    app.isPackaged &&
    saved.launchAtLogin !== previous.launchAtLogin
  )
    app.setLoginItemSettings({ openAtLogin: saved.launchAtLogin });
  if (runtimeChanged) await asr.unload();
  if (magicRuntimeChanged) await asr.unloadMagic();
  const residencyChanged =
    next.preloadModel !== previous.preloadModel ||
    next.preloadMagicModel !== previous.preloadMagicModel ||
    next.magicEnabled !== previous.magicEnabled ||
    next.modelIdleMinutes !== previous.modelIdleMinutes;
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

function assertRuntimeIdle(): void {
  if (dictation.isActive || asr.isBusy)
    throw new Error("Finish the current recording or model operation first");
}

async function start(): Promise<void> {
  if (!smokeTest) ensureDevelopmentDesktopEntry();
  storage = new StorageService();
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
  paste = new PasteService(
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
  pill = new PillService(
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
    () => !dictation?.isActive && !asr.isBusy,
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
      lastTranscript = record;
      sessionTranscripts.set(record.id, record);
      if (sessionTranscripts.size > 500)
        sessionTranscripts.delete(sessionTranscripts.keys().next().value!);
      broadcast("history:added", record);
      rebuildTrayMenu();
    },
    (transcriptId, detail) => {
      if (storage.findHistory(transcriptId) || sessionTranscripts.has(transcriptId))
        setPasteRecovery({ transcriptId, detail });
    },
    (counts) => ruleUsage.record(counts, storage.getSettings().customWords.map((rule) => rule.id)),
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
  shortcut = new ShortcutService(() => storage.getSettings().shortcutMode, {
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
  shortcut.onStatus((status) => broadcast("shortcut:statusChanged", status));
  setupPermissions();
  registerMainIpc({ getMainWindow: () => mainWindow, storage, asr, paste, pill, dictation, shortcut, updates, persistSettings, settingsBusy: () => settingsQueue.busy, getLastTranscript: () => lastTranscript, setLastTranscript: (record) => { lastTranscript = record; }, sessionTranscripts, rebuildTrayMenu, pasteLast, modelCache, ruleUsage, schedulePasteLast, getPasteRecovery: () => pasteRecovery, setPasteRecovery, applySettings, settingsQueue, broadcast, selectedAudioFiles });
  if (!smokeTest) {
    if (app.isPackaged)
      void shortcut
        .register(storage.getSettings().shortcut)
        .catch(() => undefined);
    installTray();
  }
  const updateTimer = setTimeout(() => void updates.check(), 8_000);
  updateTimer.unref();
  if (!smokeTest && app.isPackaged)
    app.setLoginItemSettings({
      openAtLogin: storage.getSettings().launchAtLogin,
    });
  await asr.initialize(storage.getSettings());
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  console.error(
    "Delulu Talks is already running; forwarding this launch to the existing instance.",
  );
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
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
app.on("before-quit", () => {
  quitting = true;
  dictation?.releaseRetryAudio();
  pill?.shutdown();
  pasteLast?.shutdown();
  paste?.shutdown();
  void shortcut?.shutdown();
  void asr?.shutdown();
});
app.on("window-all-closed", () => {
  // Delulu Talks is tray-first and intentionally remains available.
});
