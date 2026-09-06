import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
  Tray,
} from "electron";
import type { MenuItemConstructorOptions } from "electron";
import electronUpdater from "electron-updater";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type {
  AppSettings,
  ExportFormat,
  LabRequest,
  MagicPreset,
  MagicRewriteRequest,
  Page,
  RecordingSubmission,
  TranscriptRecord,
  TranscriptVersion,
} from "../src/types";
import { modelById } from "../src/data";
import { deliveredText } from "../src/transcriptText";
import { runtimeDiagnostics } from "./runtime/diagnostics";
import { SerialQueue } from "./runtime/serialQueue";
import { AsrService } from "./services/asr";
import { DictationService } from "./services/dictation";
import { PasteService } from "./services/paste";
import { PillService } from "./services/pill";
import { ShortcutService } from "./services/shortcut";
import {
  applyTranscriptEdit,
  normalizeSettings,
  StorageService,
} from "./services/storage";
import { exportRecord } from "./services/transcripts";
import { UpdateService } from "./services/updates";

const { autoUpdater } = electronUpdater;

if (
  process.platform === "linux" &&
  process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland"
) {
  // ASR CUDA runs in Python and is unaffected by Chromium's compositor.
  app.commandLine.appendSwitch("disable-gpu");
}
app.setName("Delulu Talks");
if (process.platform === "linux") app.setDesktopName("delulu-talks.desktop");
if (!app.isPackaged && process.env.DELULU_USER_DATA_DIR)
  app.setPath("userData", resolve(process.env.DELULU_USER_DATA_DIR));

const smokeTest = !app.isPackaged && process.env.DELULU_SMOKE_TEST === "1";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let storage: StorageService;
let asr: AsrService;
let paste: PasteService;
let pill: PillService;
let dictation: DictationService;
let shortcut: ShortcutService;
let updates: UpdateService;
const settingsQueue = new SerialQueue();
let lastTranscript: TranscriptRecord | null = null;
const sessionTranscripts = new Map<string, TranscriptRecord>();
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

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: "Delulu Talks",
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

function engineLabel(
  engine: ReturnType<AsrService["getStatus"]>["engine"],
): string {
  return {
    missing: "Setup needed",
    unloaded: "Sleeping",
    settingUp: "Installing…",
    loading: "Loading…",
    ready: "Ready",
    error: "Needs attention",
  }[engine];
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
            label: "Set up speech model…",
            enabled: !speechBusy,
            click: () => showMainWindow("models"),
          };
  const magicAction: MenuItemConstructorOptions = !settings.magicEnabled
    ? { label: "Enable Magic to load its model", enabled: false }
    : magic.engine === "ready"
      ? {
          label: "Unload Magic model",
          enabled: !magicBusy,
          click: () => runTrayAction(() => asr.unloadMagic(), true),
        }
      : magic.engine === "unloaded"
        ? {
            label: "Load Magic model now",
            enabled: !magicBusy,
            click: () =>
              runTrayAction(() => asr.loadMagic(storage.getSettings()), true),
          }
        : {
            label: "Set up Magic model…",
            enabled: !magicBusy,
            click: () => showMainWindow("magic"),
          };

  return [
    {
      label: `Speech · ${engineLabel(speech.engine)}`,
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
      label: `Magic · ${settings.magicEnabled ? engineLabel(magic.engine) : "Off"}`,
      sublabel: magic.message,
      enabled: false,
    },
    magicAction,
    {
      type: "checkbox",
      label: "Keep Magic model ready",
      checked: settings.preloadMagicModel,
      enabled: settings.magicEnabled,
      click: () =>
        patchTraySettings({ preloadMagicModel: !settings.preloadMagicModel }),
    },
  ];
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
  const presets: Array<[MagicPreset, string]> = [
    ["polish", "Polish naturally"],
    ["concise", "Make it concise"],
    ["structured", "Structure the details"],
    ["prompt", "Build an actionable prompt"],
  ];
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
      enabled: Boolean(latest) && !dictation.isActive,
      click: () =>
        runTrayAction(async () => {
          if (latest) await paste.paste(deliveredText(latest));
        }),
    },
    {
      label: "Copy latest result",
      sublabel: latest
        ? deliveredText(latest).replace(/\s+/g, " ").slice(0, 72)
        : "Your most recent dictation appears here",
      enabled: Boolean(latest),
      click: () => {
        if (latest) paste.copy(deliveredText(latest));
      },
    },
    { type: "separator" },
    {
      type: "checkbox",
      label: "✦  Magic after dictation",
      checked: settings.magicEnabled,
      click: () => patchTraySettings({ magicEnabled: !settings.magicEnabled }),
    },
    {
      label: "Magic style",
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
    { label: "Local engines", submenu: runtimeMenu(settings) },
    {
      label: "Open workspace",
      submenu: [
        { label: "Magic", click: () => showMainWindow("magic") },
        { label: "History", click: () => showMainWindow("history") },
        { label: "Models & runtime", click: () => showMainWindow("models") },
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
        : engineLabel(status.engine);
  tray.setToolTip(
    `Delulu Talks — ${state}${settings.magicEnabled ? ` · Magic ${engineLabel(magic.engine)}` : " · Magic off"}`,
  );
}

function installTray(): void {
  const icon = nativeImage
    .createFromPath(iconPath())
    .resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  rebuildTrayMenu();
  tray.on("click", () => showMainWindow("home"));
}

function ensureDevelopmentDesktopEntry(): void {
  if (process.platform !== "linux" || app.isPackaged) return;
  const dataHome =
    process.env.XDG_DATA_HOME || join(app.getPath("home"), ".local", "share");
  const applicationsDirectory = join(dataHome, "applications");
  const desktopPath = join(applicationsDirectory, "delulu-talks.desktop");
  const quote = (value: string) =>
    `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const entry = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Delulu Talks",
    `Exec=${quote(process.execPath)} ${quote(app.getAppPath())}`,
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

async function applySettings(value: unknown): Promise<AppSettings> {
  const previous = storage.getSettings();
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a settings object");
  const next = normalizeSettings({ ...previous, ...value });
  if (next.shortcut !== previous.shortcut) {
    try {
      await shortcut.register(next.shortcut);
    } catch {
      await shortcut.register(previous.shortcut).catch(() => undefined);
      throw new Error(
        `Global shortcut '${next.shortcut}' is unavailable. ${previous.shortcut} remains active.`,
      );
    }
  }
  const runtimeChanged =
    next.model !== previous.model ||
    next.backend !== previous.backend ||
    next.computeType !== previous.computeType ||
    next.speculativeDecoding !== previous.speculativeDecoding;
  const magicRuntimeChanged = next.magicModel !== previous.magicModel;
  if (
    (runtimeChanged ||
      magicRuntimeChanged ||
      next.magicEnabled !== previous.magicEnabled) &&
    (dictation.isActive || asr.isBusy)
  )
    throw new Error(
      "Finish the current recording or model operation before changing engines",
    );
  const saved = storage.updateSettings(next);
  if (!smokeTest && saved.launchAtLogin !== previous.launchAtLogin)
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

function registerIpc(): void {
  const handle = <Args extends unknown[]>(
    channel: string,
    listener: (event: Electron.IpcMainInvokeEvent, ...args: Args) => unknown,
  ) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (
        event.sender !== mainWindow?.webContents ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error("Untrusted IPC sender");
      return listener(event, ...(args as Args));
    });
  };
  handle("runtime:diagnostics", () => runtimeDiagnostics(storage));
  handle("dictation:pasteLast", async () => {
    const record = lastTranscript
      ? (storage.findHistory(lastTranscript.id) ?? lastTranscript)
      : storage.getHistory()[0];
    if (!record) throw new Error("Record something first");
    if (dictation.isActive)
      throw new Error("Finish the current recording first");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    if (dictation.isActive)
      throw new Error("Paste cancelled because a recording started");
    await paste.paste(deliveredText(record));
  });
  handle("dictation:discardFailed", () => dictation.discardFailure());
  handle("dictation:retry", () => dictation.retry());
  handle("settings:get", () => storage.getSettings());
  handle("settings:update", (_event, value: unknown) => persistSettings(value));
  handle("runtime:status", () => asr.getStatus());
  handle("shortcut:status", () => shortcut.getStatus());
  handle("shortcut:configure", () => shortcut.configure());
  handle("runtime:setup", () => {
    assertRuntimeIdle();
    return asr.setup(storage.getSettings());
  });
  handle("runtime:load", () => {
    assertRuntimeIdle();
    return asr.loadModel(storage.getSettings());
  });
  handle("runtime:unload", () => {
    assertRuntimeIdle();
    return asr.unload();
  });
  handle("runtime:reset", () => {
    assertRuntimeIdle();
    return asr.reset();
  });
  handle("magic:status", () => asr.getMagicStatus());
  handle("magic:setup", () => {
    assertRuntimeIdle();
    return asr.setupMagic(storage.getSettings());
  });
  handle("magic:load", () => {
    assertRuntimeIdle();
    return asr.loadMagic(storage.getSettings());
  });
  handle("magic:unload", () => {
    assertRuntimeIdle();
    return asr.unloadMagic();
  });
  handle("magic:rewrite", (_event, value: unknown) => {
    if (!value || typeof value !== "object")
      throw new Error("Expected a Magic rewrite request");
    const source = value as Record<string, unknown>;
    const preset = ["polish", "concise", "structured", "prompt"].includes(
      String(source.preset),
    )
      ? (source.preset as MagicRewriteRequest["preset"])
      : "polish";
    const request: MagicRewriteRequest = {
      text: validateText(source.text, 50_000).trim(),
      preset,
      instructions: validateText(source.instructions ?? "", 4_000).trim(),
      allowInferences: source.allowInferences === true,
    };
    if (!request.text)
      throw new Error("Add a transcript or draft before using Magic");
    assertRuntimeIdle();
    return asr.rewriteMagic(request, storage.getSettings());
  });
  handle("platform:capabilities", () =>
    paste.capabilities(pill.method, pill.detail),
  );
  handle("updates:get", () => updates.getStatus());
  handle("updates:check", () => updates.check());
  handle("updates:download", () => updates.download());
  handle("updates:install", () => updates.install());
  handle("dictation:start", () => dictation.start());
  handle("dictation:stop", () => dictation.stop());
  handle("dictation:toggle", () => dictation.toggle());
  handle("dictation:cancel", () => dictation.cancel());
  handle("recorder:started", () => dictation.recordingStarted());
  handle("recorder:ready", () => dictation.recorderAvailable());
  handle("recorder:failed", (_event, message: unknown) =>
    dictation.recordingFailed(validateText(message, 1000)),
  );
  handle("recorder:submit", (_event, submission: RecordingSubmission) =>
    dictation.submitRecording(submission),
  );
  ipcMain.on("recorder:level", (event, value: unknown) => {
    if (
      event.sender !== mainWindow?.webContents ||
      event.senderFrame !== event.sender.mainFrame
    )
      return;
    const level =
      typeof value === "number" && Number.isFinite(value)
        ? Math.min(1, Math.max(0, value))
        : 0;
    dictation.recordingLevel(level);
  });
  handle("clipboard:copy", (_event, text: unknown) =>
    paste.copy(validateText(text, 500_000)),
  );
  handle("paste:authorize", () => paste.authorize());
  handle("paste:test", async () => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
    await paste.paste("Delulu Talks paste test");
  });
  handle("history:get", () => {
    const records = new Map(
      storage.getHistory().map((record) => [record.id, record]),
    );
    for (const [id, record] of sessionTranscripts) records.set(id, record);
    return [...records.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 500);
  });
  handle(
    "history:updateTranscript",
    (_event, id: unknown, requestedVersion: unknown, text: unknown) => {
      if (requestedVersion !== "intended" && requestedVersion !== "verbatim")
        throw new Error("Unknown transcript version");
      const version: TranscriptVersion = requestedVersion;
      const key = validateText(id, 128);
      const correction = text === null ? null : validateText(text, 500_000);
      const sessionRecord = sessionTranscripts.get(key);
      const updated = storage.findHistory(key)
        ? storage.updateTranscript(key, version, correction)
        : sessionRecord
          ? applyTranscriptEdit(sessionRecord, version, correction)
          : null;
      if (!updated) throw new Error("Transcript not found");
      sessionTranscripts.set(key, updated);
      if (lastTranscript?.id === key) lastTranscript = updated;
      rebuildTrayMenu();
      return updated;
    },
  );
  handle("history:delete", (_event, id: unknown) => {
    const key = validateText(id, 128);
    storage.deleteHistory(key);
    sessionTranscripts.delete(key);
    if (lastTranscript?.id === key) lastTranscript = null;
    rebuildTrayMenu();
  });
  handle("history:clear", () => {
    storage.clearHistory();
    sessionTranscripts.clear();
    lastTranscript = null;
    rebuildTrayMenu();
  });
  handle("lab:chooseAudio", async () => {
    const options: Electron.OpenDialogOptions = {
      title: "Choose audio or video",
      properties: ["openFile"],
      filters: [
        {
          name: "Audio and video",
          extensions: [
            "wav",
            "mp3",
            "m4a",
            "flac",
            "ogg",
            "opus",
            "webm",
            "mp4",
            "mov",
            "mkv",
          ],
        },
      ],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    const path = result.canceled ? undefined : result.filePaths[0];
    if (!path) return null;
    const resolved = resolve(path);
    selectedAudioFiles.add(resolved);
    return {
      path: resolved,
      name: basename(resolved),
      size: statSync(resolved).size,
    };
  });
  handle("lab:run", async (_event, request: LabRequest) => {
    const path = resolve(validateText(request.path, 4096));
    if (!selectedAudioFiles.has(path) || !existsSync(path))
      throw new Error("Choose the source file through Speech Lab first");
    const operation = ["transcribe", "verbatimize", "forcedAlign"].includes(
      request.operation,
    )
      ? request.operation
      : "transcribe";
    return dictation.runLab({
      operation,
      path,
      mode: ["intended", "verbatim", "dual"].includes(String(request.mode))
        ? request.mode
        : undefined,
      referenceText: request.referenceText
        ? validateText(request.referenceText, 500_000)
        : undefined,
    });
  });
  handle(
    "history:export",
    async (_event, id: unknown, requestedFormat: ExportFormat) => {
      const key = validateText(id, 128);
      const record = sessionTranscripts.get(key) ?? storage.findHistory(key);
      if (!record) throw new Error("Transcript not found");
      const format = ["txt", "json", "srt", "vtt"].includes(requestedFormat)
        ? requestedFormat
        : "txt";
      if (
        (format === "srt" || format === "vtt") &&
        !record.words.length &&
        !record.verbatimWords.length
      )
        throw new Error(
          "This transcript has no word timing to export as captions",
        );
      const defaultName = `${(record.sourceName ?? `delulu-${record.createdAt}`).replace(/\.[^.]+$/, "")}.${format}`;
      const options: Electron.SaveDialogOptions = {
        title: `Export ${format.toUpperCase()}`,
        defaultPath: defaultName,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      };
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      const outputPath = extname(result.filePath)
        ? result.filePath
        : `${result.filePath}.${format}`;
      writeFileSync(outputPath, exportRecord(record, format), "utf8");
      return outputPath;
    },
  );
}

async function start(): Promise<void> {
  if (!smokeTest) ensureDevelopmentDesktopEntry();
  storage = new StorageService();
  paste = new PasteService(
    () => storage.getSettings().pastePortalToken || null,
    (pastePortalToken) => {
      const saved = storage.updateSettings({
        ...storage.getSettings(),
        pastePortalToken,
      });
      broadcast("settings:changed", saved);
    },
  );
  pill = new PillService(
    smokeTest ? { env: { ...process.env, XDG_SESSION_TYPE: "" } } : {},
  );
  if (!smokeTest && storage.getSettings().showOverlay) pill.prepare();
  asr = new AsrService(storage);
  updates = new UpdateService(
    app.isPackaged && (process.platform !== "linux" || !!process.env.APPIMAGE)
      ? autoUpdater
      : null,
    app.getVersion(),
    (status) => {
      broadcast("updates:statusChanged", status);
      rebuildTrayMenu();
    },
    () => !dictation?.isActive && !asr.isBusy,
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
  );
  mainWindow.webContents.on("did-start-loading", () =>
    dictation.recorderUnavailable(),
  );
  shortcut = new ShortcutService(() => storage.getSettings().shortcutMode, {
    start: () => dictation.start(),
    stop: () => dictation.stop(),
    toggle: () => dictation.toggle(),
  });
  asr.onStatus((status) => {
    broadcast("runtime:statusChanged", status);
    rebuildTrayMenu();
  });
  asr.onMagicStatus((status) => {
    broadcast("magic:statusChanged", status);
    rebuildTrayMenu();
  });
  shortcut.onStatus((status) => broadcast("shortcut:statusChanged", status));
  setupPermissions();
  registerIpc();
  if (!smokeTest) {
    void shortcut
      .register(storage.getSettings().shortcut)
      .catch(() => undefined);
    installTray();
  }
  const updateTimer = setTimeout(() => void updates.check(), 8_000);
  updateTimer.unref();
  if (!smokeTest)
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
  pill?.shutdown();
  paste?.shutdown();
  void shortcut?.shutdown();
  void asr?.shutdown();
});
app.on("window-all-closed", () => {
  // Delulu Talks is tray-first and intentionally remains available.
});
