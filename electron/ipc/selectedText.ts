import { app, globalShortcut } from "electron";
import { SelectedTextService } from "../services/selectedText";
import type { SelectedTextState } from "../../src/selectedText";
import type { IpcDependencies, IpcRegistrar } from "./types";

export function registerSelectedTextIpc({handle}: IpcRegistrar, dependencies: IpcDependencies): void {
  const {getMainWindow,dictation,asr,paste,settingsBusy,broadcast} = dependencies;
  const service = new SelectedTextService(() => !dictation.isActive && !asr.isBusy && !settingsBusy(), (body) => paste.withClipboardLease(body));
  const shortcut = "CommandOrControl+Shift+R";
  let enabled = false;
  let error: string | null = null;
  const state = (): SelectedTextState => ({enabled,supported:service.supported,shortcut,session:service.session,error});
  const publish = () => broadcast("selectedText:changed",state());
  const capture = async () => {
    if (!enabled) return;
    try { await service.capture(); error = null; }
    catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    if (!enabled) { service.discard(); return; }
    const window = getMainWindow();
    window?.show(); window?.focus();
    publish();
  };
  handle("selectedText:state",state);
  handle("selectedText:enable", (_event,value:unknown) => {
    if (typeof value !== "boolean") throw new Error("Expected explicit selection shortcut consent.");
    if (!value) {
      if (enabled) globalShortcut.unregister(shortcut);
      enabled = false; service.discard(); error = null; publish(); return state();
    }
    if (!service.supported) throw new Error("External selected-text capture currently supports X11 only. Use the editor workflow or manually entered source on this desktop.");
    if (!enabled && !globalShortcut.register(shortcut,() => { void capture(); })) throw new Error("Selection shortcut could not be registered. Choose another workflow; no native capture was enabled.");
    enabled = true; error = null; publish(); return state();
  });
  handle("selectedText:discard", (_event,id:unknown) => {
    if (typeof id !== "string") throw new Error("Invalid selection session.");
    service.discard(id); publish();
  });
  handle("selectedText:replace", async (_event,id:unknown,text:unknown) => {
    if (!enabled || typeof id !== "string" || typeof text !== "string") throw new Error("Invalid or disabled selection session.");
    try { await service.replace(id,text); error = null; }
    catch (reason) { error = reason instanceof Error ? reason.message : String(reason); throw reason; }
    finally { publish(); }
  });
  const dispose = () => { if (enabled) globalShortcut.unregister(shortcut); enabled = false; service.discard(); };
  app.on("before-quit",dispose);
  getMainWindow()?.webContents.on("did-start-loading",dispose);
}
