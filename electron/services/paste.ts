import { clipboard } from "electron";
import { spawn, spawnSync } from "node:child_process";
import type { PlatformCapabilities } from "../../src/types";

type PasteCommand = { program: string; args: string[]; input?: string };

function exists(program: string): boolean {
  const command = process.platform === "win32" ? "where" : "which";
  return spawnSync(command, [program], { stdio: "ignore", windowsHide: true }).status === 0;
}

export class PasteService {
  private readonly command: PasteCommand | null;

  constructor() {
    this.command = this.resolveCommand();
  }

  private resolveCommand(): PasteCommand | null {
    if (process.platform === "darwin") {
      return { program: "osascript", args: ["-e", "tell application \"System Events\" to keystroke \"v\" using command down"] };
    }
    if (process.platform === "win32") {
      return { program: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"] };
    }
    if (process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland") {
      if (exists("wtype")) return { program: "wtype", args: ["-M", "ctrl", "v", "-m", "ctrl"] };
      if (exists("ydotool")) return { program: "ydotool", args: ["key", "29:1", "47:1", "47:0", "29:0"] };
      if (exists("dotool")) return { program: "dotool", args: [], input: "key ctrl+v\n" };
    }
    if (exists("xdotool")) return { program: "xdotool", args: ["key", "--clearmodifiers", "ctrl+v"] };
    return null;
  }

  copy(text: string): void {
    clipboard.writeText(text);
  }

  async paste(text: string): Promise<string> {
    this.copy(text);
    if (!this.command) {
      throw new Error("no compatible input injector is installed; the transcript is on the clipboard");
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    await new Promise<void>((resolvePaste, reject) => {
      const child = spawn(this.command!.program, this.command!.args, { windowsHide: true });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      if (this.command!.input) child.stdin.end(this.command!.input);
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolvePaste() : reject(new Error(stderr.trim() || `${this.command!.program} exited with code ${code}`)));
    });
    return this.command.program;
  }

  capabilities(overlayMethod: PlatformCapabilities["overlayMethod"] = "unavailable", overlayDetail?: string): PlatformCapabilities {
    const sessionType = process.env.XDG_SESSION_TYPE?.toLowerCase() ?? "unknown";
    return {
      platform: process.platform as PlatformCapabilities["platform"],
      desktop: process.env.XDG_CURRENT_DESKTOP ?? process.env.DESKTOP_SESSION ?? "unknown",
      sessionType,
      pasteMethod: this.command?.program ?? "clipboard-only",
      overlayMethod,
      overlayDetail,
      wayland: sessionType === "wayland",
    };
  }
}
