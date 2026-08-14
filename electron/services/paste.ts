import { clipboard } from "electron";
import { spawn, spawnSync } from "node:child_process";
import { sessionBus, Variant, type ClientInterface, type MessageBus } from "dbus-next";
import type { PlatformCapabilities } from "../../src/types";
import { compatibleSessionBusAddress } from "../compat";
import { portalRequest, PORTAL_NAME, PORTAL_PATH } from "./shortcutPortal";

type PasteCommand = { program: string; args: string[]; input?: string };
type PortalInterface = ClientInterface & Record<string, (...args: unknown[]) => Promise<unknown>>;
type ConnectedBus = MessageBus & { name: string | null };

const APP_ID = "delulu-talks";
const KEYBOARD = 1;
const KEYSYM_LEFTCTRL = 0xffe3;
const KEYSYM_V = 0x76;

function exists(program: string): boolean {
  const command = process.platform === "win32" ? "where" : "which";
  return spawnSync(command, [program], { stdio: "ignore", windowsHide: true }).status === 0;
}

function variantValue<T>(value: Variant<T> | T | undefined): T | undefined {
  return value instanceof Variant ? value.value : value;
}

export class PasteService {
  private readonly waylandPortal = process.platform === "linux" && process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland";
  private readonly kdeWayland = this.waylandPortal && /(?:^|:)KDE(?:$|:)/i.test(process.env.XDG_CURRENT_DESKTOP ?? "");
  private readonly qdbus = exists("qdbus6") ? "qdbus6" : exists("qdbus") ? "qdbus" : null;
  private readonly command: PasteCommand | null;
  private bus: ConnectedBus | null = null;
  private remoteDesktop: PortalInterface | null = null;
  private portalSession: string | null = null;
  private portalReady: Promise<void> | null = null;

  constructor(
    private readonly getRestoreToken: () => string | null = () => null,
    private readonly saveRestoreToken: (token: string) => void = () => undefined,
  ) {
    this.command = this.resolveCommand();
  }

  private resolveCommand(): PasteCommand | null {
    if (process.platform === "darwin") {
      return { program: "osascript", args: ["-e", "tell application \"System Events\" to keystroke \"v\" using command down"] };
    }
    if (process.platform === "win32") {
      return { program: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"] };
    }
    if (exists("xdotool")) return { program: "xdotool", args: ["key", "--clearmodifiers", "ctrl+v"] };
    return null;
  }

  copy(text: string): void {
    clipboard.writeText(text);
    // Native-Wayland Electron can retain clipboard ownership without Klipper
    // observing the new text, causing Ctrl+V in another app to paste the
    // previous clipboard item. Publish through Plasma's clipboard service as
    // well so the destination sees the transcript after focus has moved.
    if (this.kdeWayland && this.qdbus) {
      const result = spawnSync(this.qdbus, ["org.kde.klipper", "/klipper", "setClipboardContents", text], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (result.status !== 0) throw new Error(result.stderr.trim() || "KDE clipboard rejected the transcript");
    }
  }

  async authorize(): Promise<void> {
    if (!this.waylandPortal) return;
    await this.ensurePortalSession();
  }

  async paste(text: string): Promise<string> {
    this.copy(text);
    if (this.waylandPortal) {
      await this.pasteThroughPortal();
      return "wayland-portal";
    }
    if (!this.command) throw new Error("no compatible input injector is available; the transcript is on the clipboard");
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

  private async pasteThroughPortal(): Promise<void> {
    await this.ensurePortalSession();
    if (!this.remoteDesktop || !this.portalSession) throw new Error("Wayland paste permission is unavailable");
    // Let the portal dialog close and restore focus before emitting Ctrl+V.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 220));
    for (const [keysym, state] of [[KEYSYM_LEFTCTRL, 1], [KEYSYM_V, 1], [KEYSYM_V, 0], [KEYSYM_LEFTCTRL, 0]] as const) {
      await this.remoteDesktop.NotifyKeyboardKeysym(this.portalSession, {}, keysym, state);
    }
  }

  private ensurePortalSession(): Promise<void> {
    if (this.remoteDesktop && this.portalSession) return Promise.resolve();
    if (this.portalReady) return this.portalReady;
    this.portalReady = this.openPortalSession().catch(async (error) => {
      await this.closePortal();
      throw error;
    }).finally(() => { this.portalReady = null; });
    return this.portalReady;
  }

  private async openPortalSession(): Promise<void> {
    const busAddress = compatibleSessionBusAddress(process.env);
    const bus = sessionBus(busAddress ? { busAddress } : undefined) as ConnectedBus;
    this.bus = bus;
    const object = await bus.getProxyObject(PORTAL_NAME, PORTAL_PATH);
    try {
      await (object.getInterface("org.freedesktop.host.portal.Registry") as PortalInterface).Register(APP_ID, {});
    } catch { /* A recognized packaged application does not need host registration. */ }
    const remoteDesktop = object.getInterface("org.freedesktop.portal.RemoteDesktop") as PortalInterface;
    this.remoteDesktop = remoteDesktop;
    const token = `delulu_paste_${process.pid}_${Date.now()}`;
    const [createCode, createResults] = await portalRequest(bus, `${token}_create`, (handleToken) => remoteDesktop.CreateSession({
      handle_token: new Variant("s", handleToken),
      session_handle_token: new Variant("s", `${token}_session`),
    }) as Promise<string>);
    if (createCode !== 0) throw new Error(createCode === 1 ? "Automatic paste permission was cancelled" : "Could not create a Wayland paste session");
    const session = String(variantValue(createResults.session_handle) ?? "");
    if (!session) throw new Error("The Wayland portal returned no paste session");
    this.portalSession = session;

    const restoreToken = this.getRestoreToken();
    const selectOptions: Record<string, Variant> = {
      handle_token: new Variant("s", `${token}_select`),
      types: new Variant("u", KEYBOARD),
      persist_mode: new Variant("u", 2),
    };
    if (restoreToken) selectOptions.restore_token = new Variant("s", restoreToken);
    const [selectCode] = await portalRequest(bus, `${token}_select`, (handleToken) => {
      selectOptions.handle_token = new Variant("s", handleToken);
      return remoteDesktop.SelectDevices(session, selectOptions) as Promise<string>;
    });
    if (selectCode !== 0) throw new Error(selectCode === 1 ? "Automatic paste permission was cancelled" : "Keyboard control was not approved");

    const [startCode, startResults] = await portalRequest(bus, `${token}_start`, (handleToken) => remoteDesktop.Start(
      session,
      "",
      { handle_token: new Variant("s", handleToken) },
    ) as Promise<string>);
    if (startCode !== 0) throw new Error(startCode === 1 ? "Automatic paste permission was cancelled" : "Could not start automatic paste");
    const devices = Number(variantValue(startResults.devices) ?? 0);
    if ((devices & KEYBOARD) === 0) throw new Error("Keyboard control was not granted; the transcript remains on the clipboard");
    const nextToken = String(variantValue(startResults.restore_token) ?? "");
    if (nextToken) this.saveRestoreToken(nextToken);
  }

  private async closePortal(): Promise<void> {
    const bus = this.bus;
    const session = this.portalSession;
    this.bus = null;
    this.remoteDesktop = null;
    this.portalSession = null;
    if (bus && session) {
      try {
        const object = await bus.getProxyObject(PORTAL_NAME, session);
        await object.getInterface("org.freedesktop.portal.Session").Close();
      } catch { /* Disconnecting also closes the session. */ }
    }
    bus?.disconnect();
  }

  shutdown(): void {
    void this.closePortal();
  }

  capabilities(overlayMethod: PlatformCapabilities["overlayMethod"] = "unavailable", overlayDetail?: string): PlatformCapabilities {
    const sessionType = process.env.XDG_SESSION_TYPE?.toLowerCase() ?? "unknown";
    return {
      platform: process.platform as PlatformCapabilities["platform"],
      desktop: process.env.XDG_CURRENT_DESKTOP ?? process.env.DESKTOP_SESSION ?? "unknown",
      sessionType,
      pasteMethod: this.waylandPortal ? "wayland-portal" : this.command?.program ?? "clipboard-only",
      overlayMethod,
      overlayDetail,
      wayland: sessionType === "wayland",
    };
  }
}
