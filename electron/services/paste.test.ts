import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import { PasteService, ClipboardCopyError, type PasteIo } from "./paste";

const dangerousText = "$(touch /tmp/never-run); {ENTER}\r\nhéllo 👋";
function fixture(platform: NodeJS.Platform = "linux", wayland = false) {
  const copied: string[] = [],
    commands: { program: string; args: readonly string[] }[] = [];
  let clipboardFailure = false,
    injectionFailure = false;
  let current = "Original clipboard";
  let now = 0;
  const polls = new Set<() => void>();
  const io: PasteIo = {
    platform,
    env: { XDG_SESSION_TYPE: wayland ? "wayland" : "x11" },
    clipboard: {
      writeText: (text) => {
        if (clipboardFailure) throw new Error("Clipboard rejected");
        copied.push(text);
        current = text;
      },
      readText: () => current,
      availableFormats: () => ["text/plain"],
      readBuffer: () => Buffer.from(current),
    },
    delay: async () => {},
    restoreClock: {
      now: () => now,
      every: (poll) => {
        polls.add(poll);
        return () => {
          polls.delete(poll);
        };
      },
    },
    accessibilityPermission: () => ({
      state: "granted",
      canAttemptPaste: true,
      detail: "Allowed",
    }),
    spawnSync: (() => ({ status: 0 })) as unknown as PasteIo["spawnSync"],
    spawn: ((program: string, args: readonly string[]) => {
      commands.push({ program, args });
      const child = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        stdin: {
          end: () => {
            throw new Error("Transcript entered a subprocess");
          },
        },
      });
      queueMicrotask(() => {
        if (injectionFailure)
          child.stderr.emit("data", Buffer.from("Injection denied"));
        child.emit("exit", injectionFailure ? 1 : 0);
      });
      return child;
    }) as unknown as PasteIo["spawn"],
  };
  const service = new PasteService(undefined, undefined, io);
  return {
    service,
    io,
    copied,
    commands,
    clipboardFailure: () => {
      clipboardFailure = true;
    },
    injectionFailure: () => {
      injectionFailure = true;
    },
    advance: (milliseconds: number) => {
      now += milliseconds;
      for (const poll of polls) poll();
    },
  };
}

test("desktop injection keeps arbitrary transcript data on the clipboard and sends only the configured Paste shortcut", async () => {
  for (const platform of ["darwin", "win32", "linux"] as const) {
    const f = fixture(platform);
    f.io.getShortcut = () => "terminal";
    await f.service.paste(dangerousText);
    expect(f.copied).toEqual([dangerousText]);
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0].args.join(" ")).not.toContain(dangerousText);
    expect(f.commands[0]).toEqual(
      platform === "darwin"
        ? {
            program: "osascript",
            args: [
              "-e",
              'tell application "System Events" to keystroke "v" using command down',
            ],
          }
        : platform === "win32"
          ? {
              program: "powershell.exe",
              args: [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^+v')",
              ],
            }
          : {
              program: "xdotool",
              args: ["key", "--clearmodifiers", "ctrl+shift+v"],
            },
    );
    f.service.shutdown();
  }
});

test("clipboard restoration preserves the previous text while newer writes, failure, and shutdown cancel it", async () => {
  for (const action of [
    "restore",
    "failure",
    "overwrite",
    "copy-identical",
    "shutdown",
  ] as const) {
    const f = fixture();
    if (action === "failure") {
      f.injectionFailure();
      await expect(f.service.paste("Transcript", true)).rejects.toThrow(
        "Injection denied",
      );
    } else await f.service.paste("Transcript", true);
    if (action === "overwrite") f.io.clipboard!.writeText("New user clipboard");
    if (action === "copy-identical") await f.service.copy("Transcript");
    if (action === "shutdown") f.service.shutdown();
    f.advance(2500);
    expect(f.io.clipboard!.readText()).toBe(
      action === "restore"
        ? "Original clipboard"
        : action === "overwrite"
          ? "New user clipboard"
          : "Transcript",
    );
    f.service.shutdown();
  }
});

test("clipboard write failure prevents injection; injection failure leaves recoverable text and releases ownership", async () => {
  for (const failure of ["clipboard", "injector"] as const) {
    const f = fixture();
    if (failure === "clipboard") f.clipboardFailure();
    else f.injectionFailure();
    let error: unknown;
    try {
      await f.service.paste(dangerousText);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(
      failure === "clipboard" ? ClipboardCopyError : Error,
    );
    expect(f.copied).toEqual(failure === "clipboard" ? [] : [dangerousText]);
    expect(f.commands).toHaveLength(failure === "clipboard" ? 0 : 1);
    expect(f.service.isBusy).toBe(false);
    f.service.shutdown();
  }
});

test("Wayland releases every possibly pressed key despite injection failure and preserves the original error", async () => {
  const f = fixture("linux", true);
  f.io.getShortcut = () => "terminal";
  const keys: [number, number][] = [];
  // Replace only the native portal boundary; exercise the real key cleanup logic.
  Object.assign(f.service, {
    portalSession: "/fake/session",
    remoteDesktop: {
      NotifyKeyboardKeysym: async (
        _session: string,
        _options: object,
        key: number,
        state: number,
      ) => {
        keys.push([key, state]);
        if (key === 0x76 && state === 1) throw new Error("Press failed");
        if (state === 0) throw new Error("Release failed");
      },
    },
  });
  await expect(f.service.paste(dangerousText)).rejects.toThrow("Press failed");
  expect(keys).toEqual([
    [0xffe3, 1],
    [0xffe1, 1],
    [0x76, 1],
    [0x76, 0],
    [0xffe1, 0],
    [0xffe3, 0],
  ]);
  expect(f.copied).toEqual([dangerousText]);
  expect(f.commands).toEqual([]);
  expect(f.service.isBusy).toBe(false);
  // Avoid opening a real portal while shutting down the synthetic session.
  Object.assign(f.service, { portalSession: null });
  f.service.shutdown();
});

test("KDE clipboard publication yields to the event loop and holds delivery until acknowledgement", async () => {
  const f = fixture("linux", true);
  f.service.shutdown();
  f.io.env = { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "KDE" };
  const sync = f.io.spawnSync!;
  f.io.spawnSync = ((program: string, ...args: unknown[]) => {
    if (program === "qdbus6")
      throw new Error("Clipboard publication must not block Wayland events");
    return (sync as Function)(program, ...args);
  }) as PasteIo["spawnSync"];
  let acknowledge!: () => void;
  let published = "";
  f.io.spawn = ((_program: string, args: string[]) => {
    published = args[3];
    const child = new EventEmitter();
    acknowledge = () => child.emit("exit", 0);
    return child;
  }) as PasteIo["spawn"];
  const service = new PasteService(undefined, undefined, f.io);
  let completed = false;
  const pending = service.copy(dangerousText).then(() => {
    completed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(published).toBe(dangerousText);
  expect(completed).toBe(false);
  expect(service.isBusy).toBe(true);
  await expect(service.copy("Overwrite")).rejects.toThrow(
    "already in progress",
  );
  acknowledge();
  await pending;
  expect(completed).toBe(true);
  expect(service.isBusy).toBe(false);
  service.shutdown();
});
