import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Message, MessageType, Variant, type MessageBus } from "dbus-next";
import { portalTrigger } from "./shortcutFormat";
import { portalRequest, requestPath } from "./shortcutPortal";
import { ShortcutGesture } from "./shortcutGesture";

describe("shortcut command semantics", () => {
  test("hold starts once on press and stops once on release", () => {
    const commands: string[] = [];
    const gesture = new ShortcutGesture(() => "hold", {
      start: () => commands.push("start"),
      stop: () => commands.push("stop"),
      toggle: () => commands.push("toggle"),
    });
    gesture.press(true);
    gesture.press(true);
    gesture.release();
    gesture.release();
    expect(commands).toEqual(["start", "stop"]);
  });

  test("toggle changes state on each portal press and ignores releases", () => {
    const commands: string[] = [];
    const gesture = new ShortcutGesture(() => "toggle", {
      start: () => commands.push("start"),
      stop: () => commands.push("stop"),
      toggle: () => commands.push("toggle"),
    });
    gesture.press(true);
    gesture.release();
    gesture.press(true);
    gesture.release();
    expect(commands).toEqual(["toggle", "toggle"]);
  });

  test("activation-only platforms safely use toggle behavior", () => {
    const commands: string[] = [];
    const gesture = new ShortcutGesture(() => "hold", {
      start: () => commands.push("start"),
      stop: () => commands.push("stop"),
      toggle: () => commands.push("toggle"),
    });
    gesture.press(false);
    gesture.press(false);
    expect(commands).toEqual(["toggle", "toggle"]);
  });

  test("a held gesture still stops if the preference changes before release", () => {
    const commands: string[] = [];
    let mode: "hold" | "toggle" = "hold";
    const gesture = new ShortcutGesture(() => mode, {
      start: () => commands.push("start"),
      stop: () => commands.push("stop"),
      toggle: () => commands.push("toggle"),
    });
    gesture.press(true);
    mode = "toggle";
    gesture.release();
    expect(commands).toEqual(["start", "stop"]);
  });
});

describe("Wayland shortcut conversion", () => {
  test("converts Electron accelerators to the XDG trigger format", () => {
    expect(portalTrigger("CommandOrControl+Shift+Space")).toBe("CTRL+SHIFT+space");
    expect(portalTrigger("Ctrl+Alt+M")).toBe("CTRL+ALT+m");
    expect(portalTrigger("Super+Enter")).toBe("LOGO+Return");
  });
});

describe("Wayland portal request lifecycle", () => {
  test("subscribes before invoking a portal method that responds immediately", async () => {
    const calls: string[] = [];
    const bus = Object.assign(new EventEmitter(), {
      name: ":1.42",
      call: async (message: Message) => { calls.push(message.member); return null; },
    }) as unknown as MessageBus & { name: string };
    const token = "delulu_create";
    const expected = requestPath(bus.name, token);
    const result = await portalRequest(bus, token, async () => {
      bus.emit("message", new Message({
        type: MessageType.SIGNAL,
        path: expected,
        interface: "org.freedesktop.portal.Request",
        member: "Response",
        body: [0, { session_handle: new Variant("s", "/session/one") }],
      }));
      return expected;
    }, 100);

    expect(result[0]).toBe(0);
    expect(result[1].session_handle.value).toBe("/session/one");
    expect(calls).toEqual(["AddMatch", "RemoveMatch"]);
  });
});
