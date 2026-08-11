import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  shell,
  Tray,
} from "electron";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { AppSettings, ExportFormat, LabRequest, MagicRewriteRequest, RecordingSubmission, TranscriptRecord, TranscriptVersion } from "../src/types";
import { modelById } from "../src/data";
import { AsrService } from "./services/asr";
import { DictationService } from "./services/dictation";
import { PasteService } from "./services/paste";
import { ShortcutService } from "./services/shortcut";
import { normalizeSettings, StorageService } from "./services/storage";
import { exportRecord } from "./services/transcripts";

app.commandLine.appendSwitch("enable-features", "GlobalShortcutsPortal,GlobalShortcutsPortalPreferredTrigger");
if (process.platform === "linux" && process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland") {
  // Chromium's GPU compositor is still unreliable on some current
  // NVIDIA/Plasma Wayland stacks. ASR CUDA runs in Python and is unaffected.
  app.commandLine.appendSwitch("disable-gpu");
}
app.setName("Delulu Talks");
if (process.platform === "linux") app.setDesktopName("delulu-talks.desktop");
if (!app.isPackaged && process.env.DELULU_USER_DATA_DIR) app.setPath("userData", resolve(process.env.DELULU_USER_DATA_DIR));

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let storage: StorageService;
let asr: AsrService;
let paste: PasteService;
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
  for (const window of [mainWindow, overlayWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send(channel, value);
  }
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

function placeOverlay(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const [width, height] = overlayWindow.getSize();
  const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2);
  const y = Math.round(display.workArea.y + display.workArea.height - height - 34);
  overlayWindow.setPosition(x, y, false);
}

function createOverlayWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 470,
    height: 102,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.on("show", placeOverlay);
  loadRenderer(window, { overlay: "1" });
  return window;
}

function iconPath(): string {
  const packaged = join(process.resourcesPath, "icon.png");
  return app.isPackaged && existsSync(packaged) ? packaged : resolve(app.getAppPath(), "build", "icon.png");
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
  mainWindow.show();
  mainWindow.focus();
}

function installTray(): void {
  const icon = nativeImage.createFromPath(iconPath()).resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.setToolTip("Delulu Talks");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Delulu Talks", click: showMainWindow },
    { type: "separator" },
    { label: "Start / stop dictation", click: () => dictation.toggle() },
    { label: "Load selected model", click: () => void asr.loadModel(storage.getSettings()).catch((error) => asr.fail(error)) },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("double-click", showMainWindow);
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

function registerIpc(): void {
  ipcMain.handle("settings:get", () => storage.getSettings());
  ipcMain.handle("settings:update", async (_event, value: unknown) => {
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
    return saved;
  });
  ipcMain.handle("runtime:status", () => asr.getStatus());
  ipcMain.handle("shortcut:status", () => shortcut.getStatus());
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
  ipcMain.handle("platform:capabilities", () => paste.capabilities());
  ipcMain.handle("dictation:start", () => dictation.start());
  ipcMain.handle("dictation:stop", () => dictation.stop());
  ipcMain.handle("dictation:toggle", () => dictation.toggle());
  ipcMain.handle("dictation:cancel", () => dictation.cancel());
  ipcMain.handle("recorder:started", () => dictation.recordingStarted());
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
  asr = new AsrService(storage);
  mainWindow = createMainWindow();
  overlayWindow = createOverlayWindow();
  dictation = new DictationService(
    storage,
    asr,
    paste,
    { main: () => mainWindow, overlay: () => overlayWindow },
    (record: TranscriptRecord) => broadcast("history:added", record),
  );
  shortcut = new ShortcutService(() => dictation.toggle());
  asr.onStatus((status) => broadcast("runtime:statusChanged", status));
  asr.onMagicStatus((status) => broadcast("magic:statusChanged", status));
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
  app.on("second-instance", showMainWindow);
  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox("Delulu Talks failed to start", error instanceof Error ? error.message : String(error));
    app.quit();
  });
}

app.on("activate", showMainWindow);
app.on("before-quit", () => {
  quitting = true;
  void shortcut?.shutdown();
  void asr?.shutdown();
});
app.on("window-all-closed", () => {
  // Delulu Talks is tray-first and intentionally remains available.
});
