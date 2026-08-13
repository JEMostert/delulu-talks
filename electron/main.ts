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
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { AppSettings, ExportFormat, LabRequest, MagicPreset, MagicRewriteRequest, Page, RecordingSubmission, TranscriptRecord, TranscriptVersion } from "../src/types";
import { modelById } from "../src/data";
import { deliveredText } from "../src/transcriptText";
import { AsrService } from "./services/asr";
import { DictationService } from "./services/dictation";
import { PasteService } from "./services/paste";
import { PillService } from "./services/pill";
import { ShortcutService } from "./services/shortcut";
import { normalizeSettings, StorageService } from "./services/storage";
import { exportRecord } from "./services/transcripts";

if (process.platform === "linux" && process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland") {
  // ASR CUDA runs in Python and is unaffected by Chromium's compositor.
  app.commandLine.appendSwitch("disable-gpu");
}
app.setName("Delulu Talks");
if (process.platform === "linux") app.setDesktopName("delulu-talks.desktop");
if (!app.isPackaged && process.env.DELULU_USER_DATA_DIR) app.setPath("userData", resolve(process.env.DELULU_USER_DATA_DIR));

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let storage: StorageService;
let asr: AsrService;
let paste: PasteService;
let pill: PillService;
let dictation: DictationService;
let shortcut: ShortcutService;
const selectedAudioFiles = new Set<string>();

function preloadPath(): string {
  return join(__dirname, "../preload/preload.cjs");
}

function loadRenderer(window: BrowserWindow, query?: Record<string, string>): void {
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    void window.loadURL(url.toString());
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"), { query });
  }
}

function broadcast(channel: string, value: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value);
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: "Delulu Talks",
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 650,
    center: true,
    show: false,
    backgroundColor: "#f6f2eb",
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  loadRenderer(window);
  return window;
}

function iconPath(): string {
  const packaged = join(process.resourcesPath, "icon.png");
  return app.isPackaged && existsSync(packaged) ? packaged : resolve(app.getAppPath(), "build", "icon.png");
}

function showMainWindow(page?: Page): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
  mainWindow.show();
  mainWindow.focus();
  if (!page) return;
  const navigate = () => broadcast("app:navigate", page);
  if (mainWindow.webContents.isLoadingMainFrame()) mainWindow.webContents.once("did-finish-load", navigate);
  else navigate();
}

function engineLabel(engine: ReturnType<AsrService["getStatus"]>["engine"]): string {
  return ({ missing: "Setup needed", unloaded: "Sleeping", settingUp: "Installing…", loading: "Loading…", ready: "Ready", error: "Needs attention" })[engine];
}

function runTrayAction(action: () => unknown | Promise<unknown>, magic = false): void {
  void Promise.resolve().then(action).catch((error) => magic ? asr.failMagic(error) : asr.fail(error));
}

function patchTraySettings(patch: Partial<AppSettings>): void {
  runTrayAction(() => persistSettings({ ...storage.getSettings(), ...patch }), "magicEnabled" in patch || "magicPreset" in patch || "magicAllowInferences" in patch || "preloadMagicModel" in patch);
}

function runtimeMenu(settings: AppSettings): MenuItemConstructorOptions[] {
  const speech = asr.getStatus();
  const magic = asr.getMagicStatus();
  const speechBusy = ["preparing", "loading", "transcribing"].includes(speech.phase);
  const magicBusy = ["preparing", "loading", "rewriting"].includes(magic.phase);
  const speechAction: MenuItemConstructorOptions = speech.engine === "ready"
    ? { label: "Unload speech model", enabled: !speechBusy, click: () => runTrayAction(() => asr.unload()) }
    : speech.engine === "unloaded"
      ? { label: "Load speech model now", enabled: !speechBusy, click: () => runTrayAction(() => asr.loadModel(storage.getSettings())) }
      : { label: "Set up speech model…", enabled: !speechBusy, click: () => showMainWindow("models") };
  const magicAction: MenuItemConstructorOptions = !settings.magicEnabled
    ? { label: "Enable Magicfy to load its model", enabled: false }
    : magic.engine === "ready"
      ? { label: "Unload Magic model", enabled: !magicBusy, click: () => runTrayAction(() => asr.unloadMagic(), true) }
      : magic.engine === "unloaded"
        ? { label: "Load Magic model now", enabled: !magicBusy, click: () => runTrayAction(() => asr.loadMagic(storage.getSettings()), true) }
        : { label: "Set up Magic model…", enabled: !magicBusy, click: () => showMainWindow("magic") };

  return [
    { label: `Speech · ${engineLabel(speech.engine)}`, sublabel: speech.message, enabled: false },
    speechAction,
    { type: "checkbox", label: "Keep speech model ready", checked: settings.preloadModel, click: () => patchTraySettings({ preloadModel: !settings.preloadModel }) },
    { type: "separator" },
    { label: `Magic · ${settings.magicEnabled ? engineLabel(magic.engine) : "Off"}`, sublabel: magic.message, enabled: false },
    magicAction,
    { type: "checkbox", label: "Keep Magic model ready", checked: settings.preloadMagicModel, enabled: settings.magicEnabled, click: () => patchTraySettings({ preloadMagicModel: !settings.preloadMagicModel }) },
  ];
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const settings = storage.getSettings();
  const status = asr.getStatus();
  const magic = asr.getMagicStatus();
  const latest = storage.getHistory()[0];
  const listening = status.phase === "listening";
  const dictationBusy = ["preparing", "loading", "transcribing"].includes(status.phase);
  const speechUnavailable = status.engine === "missing" || status.engine === "error";
  const presets: Array<[MagicPreset, string]> = [
    ["polish", "Polish naturally"],
    ["concise", "Make it concise"],
    ["structured", "Structure the details"],
    ["prompt", "Build an actionable prompt"],
  ];
  const template: MenuItemConstructorOptions[] = [
    { label: "DELULU TALKS", enabled: false },
    {
      label: listening ? "■  Stop & transcribe" : dictationBusy ? `●  ${status.message}` : speechUnavailable ? "!  Speech setup needs attention…" : "●  Start dictation",
      sublabel: speechUnavailable ? status.message : `Shortcut: ${settings.shortcut}`,
      enabled: listening || !dictationBusy,
      click: () => speechUnavailable ? showMainWindow("models") : dictation.toggle(),
    },
    { label: "Open Delulu Talks", click: () => showMainWindow("home") },
    { label: "Copy latest result", sublabel: latest ? deliveredText(latest).replace(/\s+/g, " ").slice(0, 72) : "Your most recent dictation appears here", enabled: Boolean(latest), click: () => { if (latest) paste.copy(deliveredText(latest)); } },
    { type: "separator" },
    { type: "checkbox", label: "✦  Magicfy after dictation", checked: settings.magicEnabled, click: () => patchTraySettings({ magicEnabled: !settings.magicEnabled }) },
    {
      label: "Magicfy style",
      enabled: settings.magicEnabled,
      submenu: presets.map(([preset, label]) => ({ type: "radio", label, checked: settings.magicPreset === preset, click: () => patchTraySettings({ magicPreset: preset }) })),
    },
    { type: "checkbox", label: "Allow helpful assumptions", checked: settings.magicAllowInferences, enabled: settings.magicEnabled, click: () => patchTraySettings({ magicAllowInferences: !settings.magicAllowInferences }) },
    { type: "separator" },
    {
      label: "Delivery & capture",
      submenu: [
        { type: "checkbox", label: "Paste automatically", checked: settings.autoPaste, click: () => patchTraySettings({ autoPaste: !settings.autoPaste }) },
        { type: "checkbox", label: "Keep a clipboard copy", checked: settings.copyToClipboard, click: () => patchTraySettings({ copyToClipboard: !settings.copyToClipboard }) },
        { type: "checkbox", label: "Show recording pill", checked: settings.showOverlay, click: () => patchTraySettings({ showOverlay: !settings.showOverlay }) },
        { type: "checkbox", label: "Save local history", checked: settings.keepHistory, click: () => patchTraySettings({ keepHistory: !settings.keepHistory }) },
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
    { type: "checkbox", label: "Launch at login", checked: settings.launchAtLogin, click: () => patchTraySettings({ launchAtLogin: !settings.launchAtLogin }) },
    { label: "Quit Delulu Talks", click: () => { quitting = true; app.quit(); } },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  const state = listening ? "Listening" : status.phase === "transcribing" ? "Transcribing" : status.engine === "ready" ? "Ready" : engineLabel(status.engine);
  tray.setToolTip(`Delulu Talks — ${state}${settings.magicEnabled ? ` · Magicfy ${engineLabel(magic.engine)}` : " · Magicfy off"}`);
}

function installTray(): void {
  const icon = nativeImage.createFromPath(iconPath()).resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  rebuildTrayMenu();
  tray.on("double-click", () => showMainWindow("home"));
}

function ensureDevelopmentDesktopEntry(): void {
  if (process.platform !== "linux" || app.isPackaged) return;
  const dataHome = process.env.XDG_DATA_HOME || join(app.getPath("home"), ".local", "share");
  const applicationsDirectory = join(dataHome, "applications");
  const desktopPath = join(applicationsDirectory, "delulu-talks.desktop");
  const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
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
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === "media");
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const mediaTypes = "mediaTypes" in details ? details.mediaTypes : [];
    const audioOnly = permission === "media" && (!mediaTypes?.length || mediaTypes.every((type: string) => type === "audio"));
    callback(audioOnly);
  });
}

function validateText(value: unknown, max: number): string {
  if (typeof value !== "string") throw new Error("Expected text input");
  return value.slice(0, max);
}

async function persistSettings(value: unknown): Promise<AppSettings> {
  const previous = storage.getSettings();
  const next = normalizeSettings(value);
  if (next.shortcut !== previous.shortcut) {
    try {
      await shortcut.register(next.shortcut);
    } catch {
      await shortcut.register(previous.shortcut).catch(() => undefined);
      throw new Error(`Global shortcut '${next.shortcut}' is unavailable. ${previous.shortcut} remains active.`);
    }
  }
  const runtimeChanged = next.model !== previous.model || next.backend !== previous.backend || next.computeType !== previous.computeType || next.speculativeDecoding !== previous.speculativeDecoding;
  const magicRuntimeChanged = next.magicModel !== previous.magicModel;
  const saved = storage.updateSettings(next);
  app.setLoginItemSettings({ openAtLogin: saved.launchAtLogin });
  if (runtimeChanged) await asr.unload();
  if (magicRuntimeChanged) await asr.unloadMagic();
  asr.configureResidency(saved);
  broadcast("settings:changed", saved);
  rebuildTrayMenu();
  return saved;
}

function registerIpc(): void {
  ipcMain.handle("settings:get", () => storage.getSettings());
  ipcMain.handle("settings:update", (_event, value: unknown) => persistSettings(value));
  ipcMain.handle("runtime:status", () => asr.getStatus());
  ipcMain.handle("shortcut:status", () => shortcut.getStatus());
  ipcMain.handle("shortcut:configure", () => shortcut.configure());
  ipcMain.handle("runtime:setup", () => asr.setup(storage.getSettings()));
  ipcMain.handle("runtime:load", () => asr.loadModel(storage.getSettings()));
  ipcMain.handle("runtime:unload", () => asr.unload());
  ipcMain.handle("runtime:reset", () => asr.reset());
  ipcMain.handle("magic:status", () => asr.getMagicStatus());
  ipcMain.handle("magic:setup", () => asr.setupMagic(storage.getSettings()));
  ipcMain.handle("magic:load", () => asr.loadMagic(storage.getSettings()));
  ipcMain.handle("magic:unload", () => asr.unloadMagic());
  ipcMain.handle("magic:rewrite", (_event, value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("Expected a Magic rewrite request");
    const source = value as Record<string, unknown>;
    const preset = ["polish", "concise", "structured", "prompt"].includes(String(source.preset)) ? source.preset as MagicRewriteRequest["preset"] : "polish";
    const request: MagicRewriteRequest = {
      text: validateText(source.text, 50_000).trim(),
      preset,
      instructions: validateText(source.instructions ?? "", 4_000).trim(),
      allowInferences: source.allowInferences === true,
    };
    if (!request.text) throw new Error("Add a transcript or draft before using Magic");
    return asr.rewriteMagic(request, storage.getSettings());
  });
  ipcMain.handle("platform:capabilities", () => paste.capabilities(pill.method, pill.detail));
  ipcMain.handle("dictation:start", () => dictation.start());
  ipcMain.handle("dictation:stop", () => dictation.stop());
  ipcMain.handle("dictation:toggle", () => dictation.toggle());
  ipcMain.handle("dictation:cancel", () => dictation.cancel());
  ipcMain.handle("recorder:started", () => dictation.recordingStarted());
  ipcMain.handle("recorder:ready", () => dictation.recorderAvailable());
  ipcMain.handle("recorder:failed", (_event, message: unknown) => dictation.recordingFailed(validateText(message, 1000)));
  ipcMain.handle("recorder:submit", (_event, submission: RecordingSubmission) => dictation.submitRecording(submission));
  ipcMain.handle("clipboard:copy", (_event, text: unknown) => paste.copy(validateText(text, 500_000)));
  ipcMain.handle("history:get", () => storage.getHistory());
  ipcMain.handle("history:updateTranscript", (_event, id: unknown, requestedVersion: unknown, text: unknown) => {
    if (requestedVersion !== "intended" && requestedVersion !== "verbatim") throw new Error("Unknown transcript version");
    const version: TranscriptVersion = requestedVersion;
    return storage.updateTranscript(validateText(id, 128), version, text === null ? null : validateText(text, 500_000));
  });
  ipcMain.handle("history:delete", (_event, id: unknown) => storage.deleteHistory(validateText(id, 128)));
  ipcMain.handle("history:clear", () => storage.clearHistory());
  ipcMain.handle("lab:chooseAudio", async () => {
    const options: Electron.OpenDialogOptions = {
      title: "Choose audio or video",
      properties: ["openFile"],
      filters: [{ name: "Audio and video", extensions: ["wav", "mp3", "m4a", "flac", "ogg", "opus", "webm", "mp4", "mov", "mkv"] }],
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    const path = result.canceled ? undefined : result.filePaths[0];
    if (!path) return null;
    const resolved = resolve(path);
    selectedAudioFiles.add(resolved);
    return { path: resolved, name: basename(resolved), size: statSync(resolved).size };
  });
  ipcMain.handle("lab:run", async (_event, request: LabRequest) => {
    const path = resolve(validateText(request.path, 4096));
    if (!selectedAudioFiles.has(path) || !existsSync(path)) throw new Error("Choose the source file through Speech Lab first");
    const operation = ["transcribe", "verbatimize", "forcedAlign"].includes(request.operation) ? request.operation : "transcribe";
    return dictation.runLab({
      operation,
      path,
      mode: ["intended", "verbatim", "dual"].includes(String(request.mode)) ? request.mode : undefined,
      referenceText: request.referenceText ? validateText(request.referenceText, 500_000) : undefined,
    });
  });
  ipcMain.handle("history:export", async (_event, id: unknown, requestedFormat: ExportFormat) => {
    const record = storage.findHistory(validateText(id, 128));
    if (!record) throw new Error("Transcript not found");
    const format = ["txt", "json", "srt", "vtt"].includes(requestedFormat) ? requestedFormat : "txt";
    if ((format === "srt" || format === "vtt") && !record.words.length && !record.verbatimWords.length) throw new Error("This transcript has no word timing to export as captions");
    const defaultName = `${(record.sourceName ?? `delulu-${record.createdAt}`).replace(/\.[^.]+$/, "")}.${format}`;
    const options: Electron.SaveDialogOptions = {
      title: `Export ${format.toUpperCase()}`,
      defaultPath: defaultName,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    };
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    const outputPath = extname(result.filePath) ? result.filePath : `${result.filePath}.${format}`;
    writeFileSync(outputPath, exportRecord(record, format), "utf8");
    return outputPath;
  });
}

async function start(): Promise<void> {
  ensureDevelopmentDesktopEntry();
  storage = new StorageService();
  paste = new PasteService();
  pill = new PillService();
  asr = new AsrService(storage);
  mainWindow = createMainWindow();
  dictation = new DictationService(
    storage,
    asr,
    paste,
    { main: () => mainWindow, pill },
    (record: TranscriptRecord) => {
      broadcast("history:added", record);
      rebuildTrayMenu();
    },
  );
  mainWindow.webContents.on("did-start-loading", () => dictation.recorderUnavailable());
  shortcut = new ShortcutService(
    () => storage.getSettings().shortcutMode,
    { start: () => dictation.start(), stop: () => dictation.stop(), toggle: () => dictation.toggle() },
  );
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
  void shortcut.register(storage.getSettings().shortcut).catch(() => undefined);
  installTray();
  app.setLoginItemSettings({ openAtLogin: storage.getSettings().launchAtLogin });
  await asr.initialize(storage.getSettings());
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox("Delulu Talks failed to start", error instanceof Error ? error.message : String(error));
    app.quit();
  });
}

app.on("activate", () => showMainWindow());
app.on("before-quit", () => {
  quitting = true;
  pill?.shutdown();
  void shortcut?.shutdown();
  void asr?.shutdown();
});
app.on("window-all-closed", () => {
  // Delulu Talks is tray-first and intentionally remains available.
});
