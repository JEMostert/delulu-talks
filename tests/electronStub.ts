import { mock } from "bun:test";

// Main-process modules import Electron at module scope. Under plain bun the
// package only exports its binary path, so tests share one inert stub.
mock.module("electron", () => {
  const stub = {
    app: {},
    BrowserWindow: class {},
    screen: {},
    globalShortcut: { register: () => true, unregisterAll: () => undefined },
    ipcMain: { handle: () => undefined, on: () => undefined },
    dialog: {},
    session: {},
  };
  return { ...stub, default: stub };
});
