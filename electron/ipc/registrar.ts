import type { IpcRequestChannel } from "../../src/ipcRequests";
import { randomUUID } from "node:crypto";
import {
  DomainError,
  domainError,
  serializeDomainError,
  type OperationResult,
} from "../../src/domainErrors";
import { ipcMain } from "electron";
import { parseIpcRequest } from "../../src/ipcRequests";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { IpcDependencies, IpcRegistrar } from "./types";

export function createIpcRegistrar(
  getMainWindow: IpcDependencies["getMainWindow"],
): IpcRegistrar {
  const isTrusted = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    event.sender === getMainWindow()?.webContents &&
    event.senderFrame === event.sender.mainFrame;

  const handle = <Args extends unknown[]>(
    channel: IpcRequestChannel,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => unknown,
  ): void => {
    ipcMain.handle(
      channel,
      async (event, ...args): Promise<OperationResult<unknown>> => {
        const operationId = randomUUID();
        try {
          if (!isTrusted(event))
            throw new DomainError("UNTRUSTED_SENDER", "Untrusted IPC sender", {
              operationId,
              operation: channel,
            });
          return {
            transport: "delulu-operation-v1",
            ok: true,
            value: await listener(
              event,
              ...(parseIpcRequest(channel, args) as Args),
            ),
          };
        } catch (reason) {
          return {
            transport: "delulu-operation-v1",
            ok: false,
            error: serializeDomainError(
              domainError(reason, { operationId, operation: channel }),
            ),
          };
        }
      },
    );
  };
  const on = <Args extends unknown[]>(
    channel: IpcRequestChannel,
    listener: (event: IpcMainEvent, ...args: Args) => void,
  ): void => {
    ipcMain.on(channel, (event, ...args) => {
      if (!isTrusted(event)) return;
      let parsed: unknown[];
      try {
        parsed = parseIpcRequest(channel, args);
      } catch {
        // Fire-and-forget payloads cannot reject a caller promise. Ignore
        // invalid input without mutating capture state or crashing main.
        return;
      }
      listener(event, ...(parsed as Args));
    });
  };
  return { handle, on };
}
