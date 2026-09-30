import { randomUUID } from "node:crypto";
import { DomainError, domainError, serializeDomainError, type OperationResult } from "../../src/domainErrors";
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
    ipcMain.handle(channel, async (event, ...args): Promise<OperationResult<unknown>> => {
      const operationId = randomUUID();
      try {
        if (!isTrusted(event)) throw new DomainError("UNTRUSTED_SENDER", "Untrusted IPC sender", { operationId, operation: channel });
        return { transport: "delulu-operation-v1", ok: true, value: await listener(event, ...(args as Args)) };
      } catch (reason) {
        return { transport: "delulu-operation-v1", ok: false, error: serializeDomainError(domainError(reason, { operationId, operation: channel })) };
      }
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
