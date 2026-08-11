import { describe, expect, test } from "bun:test";
import { portalTrigger } from "./shortcutFormat";

describe("Wayland shortcut conversion", () => {
  test("converts Electron accelerators to the XDG trigger format", () => {
    expect(portalTrigger("CommandOrControl+Shift+Space")).toBe("CTRL+SHIFT+space");
    expect(portalTrigger("Ctrl+Alt+M")).toBe("CTRL+ALT+m");
    expect(portalTrigger("Super+Enter")).toBe("LOGO+Return");
  });
});
