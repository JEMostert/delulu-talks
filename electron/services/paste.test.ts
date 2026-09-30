import { expect, test } from "bun:test";

// Each adapter runs in its own process: platform and module mocks must never
// change another test's Electron, child-process, or desktop state.
const adapterUrl = new URL("./paste.ts", import.meta.url).href;
const text =
  "printf '%s\\n' 'héllo 👋'\n$(touch /tmp/do-not-execute); {ENTER}\r\n";

async function exercise(
  platform: "darwin" | "win32" | "linux",
  session: "x11" | "wayland",
  failure = false,
  injector = true,
  kde = false,
  fixtureText = text,
) {
  const source = `
    import { mock } from "bun:test";
    import { EventEmitter } from "node:events";
    const copied = [], commands = [], keys = [], clipboardCalls = [];
    mock.module("electron", () => ({ systemPreferences: { isTrustedAccessibilityClient: () => true }, clipboard: { writeText: value => copied.push(value) } }));
    const io = {
      platform: ${JSON.stringify(platform)},
      env: { XDG_SESSION_TYPE: ${JSON.stringify(session)}, XDG_CURRENT_DESKTOP: ${kde} ? "KDE" : "test-desktop" },
      spawnSync: (program, args) => {
        if (program === "qdbus6") {
          clipboardCalls.push({ program, args });
          return { status: 0 };
        }
        return { status: (${injector} && args[0] === "xdotool") || (${kde} && args[0] === "qdbus6") ? 0 : 1 };
      },
      spawn: (program, args, options) => {
        commands.push({ program, args, options });
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = { end: value => { throw new Error("Text must never enter an input-injection process"); } };
        queueMicrotask(() => {
          if (${failure}) child.stderr.emit("data", Buffer.from("Input injection denied"));
          child.emit("exit", ${failure} ? 1 : 0);
        });
        return child;
      },
    };
    const { PasteService } = await import(${JSON.stringify(adapterUrl)});
    const service = new PasteService(undefined, undefined, io);
    if (${JSON.stringify(session)} === "wayland") {
      Object.assign(service, {
        portalSession: "/fixture/session",
        remoteDesktop: {
          NotifyKeyboardKeysym: async (session, options, key, state) => {
            keys.push({ key, state });
            if (${failure}) throw new Error("Input injection denied");
          },
        },
      });
    }
    let method = null, error = null;
    try { method = await service.paste(${JSON.stringify(fixtureText)}); }
    catch (cause) { error = cause.message; }
    process.stdout.write(JSON.stringify({ copied, commands, keys, clipboardCalls, method, error }));
  `;
  const child = Bun.spawn([process.execPath, "-e", source], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, diagnostic, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(diagnostic || `Fixture exited ${code}`);
  return JSON.parse(output) as {
    copied: string[];
    commands: { program: string; args: string[]; options: object }[];
    keys: { key: number; state: number }[];
    clipboardCalls: { program: string; args: string[] }[];
    method: string | null;
    error: string | null;
  };
}

const desktopRoutes = [
  {
    platform: "darwin" as const,
    program: "osascript",
    args: [
      "-e",
      'tell application "System Events" to keystroke "v" using command down',
    ],
  },
  {
    platform: "win32" as const,
    program: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
    ],
  },
  {
    platform: "linux" as const,
    program: "xdotool",
    args: ["key", "--clearmodifiers", "ctrl+v"],
  },
];

for (const route of desktopRoutes) {
  for (const failure of [false, true]) {
    test(`${route.platform} inserts clipboard text with Paste only, including injection failure: ${failure}`, async () => {
      const result = await exercise(route.platform, "x11", failure);
      expect(result.copied).toEqual([text]);
      // The complete invocation must contain only the fixed paste action.
      // Command syntax, line endings and SendKeys syntax in text stay data.
      expect(result.commands).toEqual([
        {
          program: route.program,
          args: route.args,
          options: { windowsHide: true },
        },
      ]);
      expect(result.keys).toEqual([]);
      expect(result.method).toBe(failure ? null : route.program);
      expect(result.error).toBe(failure ? "Input injection denied" : null);
    });
  }
}

test("Wayland emits only Ctrl+V press/release, without Return or command text", async () => {
  const result = await exercise("linux", "wayland");
  expect(result.copied).toEqual([text]);
  expect(result.commands).toEqual([]);
  expect(result.keys).toEqual([
    { key: 0xffe3, state: 1 },
    { key: 0x76, state: 1 },
    { key: 0x76, state: 0 },
    { key: 0xffe3, state: 0 },
  ]);
  expect(result.method).toBe("wayland-portal");
  expect(result.error).toBeNull();
});

test("Wayland injection failure leaves text copied and sends no execution action", async () => {
  const result = await exercise("linux", "wayland", true);
  expect(result.copied).toEqual([text]);
  expect(result.commands).toEqual([]);
  // A rejected press may have reached the compositor. Attempt its matching
  // release without injecting V, Return, or any source text after the failure.
  expect(result.keys).toEqual([
    { key: 0xffe3, state: 1 },
    { key: 0xffe3, state: 0 },
  ]);
  expect(result.method).toBeNull();
  expect(result.error).toBe("Input injection denied");
});

test("missing input injector keeps command text on the clipboard", async () => {
  const result = await exercise("linux", "x11", false, false);
  expect(result.copied).toEqual([text]);
  expect(result.commands).toEqual([]);
  expect(result.keys).toEqual([]);
  expect(result.method).toBeNull();
  expect(result.error).toContain("the transcript is on the clipboard");
});

test("KDE publishes command text as one clipboard argument and injects Paste only", async () => {
  const result = await exercise("linux", "wayland", false, true, true);
  expect(result.copied).toEqual([text]);
  expect(result.clipboardCalls).toEqual([
    {
      program: "qdbus6",
      args: ["org.kde.klipper", "/klipper", "setClipboardContents", text],
    },
  ]);
  expect(result.commands).toEqual([]);
  expect(result.keys).toEqual([
    { key: 0xffe3, state: 1 },
    { key: 0x76, state: 1 },
    { key: 0x76, state: 0 },
    { key: 0xffe3, state: 0 },
  ]);
  expect(result.error).toBeNull();
});
