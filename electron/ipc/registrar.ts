import { ipcMain } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { IpcDependencies, IpcRegistrar } from "./types";

export function createIpcRegistrar(
  getMainWindow: IpcDependencies["getMainWindow"],
): IpcRegistrar {
  const isTrusted = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    event.sender === getMainWindow()?.webContents &&
    event.senderFrame === event.sender.mainFrame;

  const handle = <Args extends unknown[]>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => unknown,
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrusted(event)) throw new Error("Untrusted IPC sender");
      return listener(event, ...(args as Args));
    });
  };
  const on = <Args extends unknown[]>(
    channel: string,
    listener: (event: IpcMainEvent, ...args: Args) => void,
  ): void => {
    ipcMain.on(channel, (event, ...args) => {
      if (!isTrusted(event)) return;
      listener(event, ...(args as Args));
    });
  };
  return { handle, on };
}
