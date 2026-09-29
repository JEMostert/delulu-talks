import { clipboard } from "electron";
import { ClipboardRestore } from "./clipboardRestore";
import { spawn, spawnSync } from "node:child_process";
import {
  sessionBus,
  Variant,
  type ClientInterface,
  type MessageBus,
} from "dbus-next";
import type { PasteShortcut, PlatformCapabilities } from "../../src/types";
import { compatibleSessionBusAddress } from "../compat";
import { getAccessibilityPermission } from "./accessibilityPermission";
import { portalRequest, PORTAL_NAME, PORTAL_PATH } from "./shortcutPortal";

export class ClipboardCopyError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ClipboardCopyError";
  }
}

type PasteCommand = { program: string; args: string[]; input?: string };
type PortalInterface = ClientInterface &
  Record<string, (...args: unknown[]) => Promise<unknown>>;
type ConnectedBus = MessageBus & { name: string | null };

export type PasteIo = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawn?: typeof spawn;
  spawnSync?: typeof spawnSync;
  getShortcut?: () => PasteShortcut;
};

const APP_ID = "delulu-talks";
const KEYBOARD = 1;
const KEYSYM_LEFTCTRL = 0xffe3;
const KEYSYM_LEFTSHIFT = 0xffe1;
const KEYSYM_V = 0x76;

function variantValue<T>(value: Variant<T> | T | undefined): T | undefined {
  return value instanceof Variant ? value.value : value;
}

export class PasteService {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly waylandPortal: boolean;
  private readonly kdeWayland: boolean;
  private readonly qdbus: string | null;
  private readonly command: PasteCommand | null;
  private readonly clipboardRestore = new ClipboardRestore();
  private bus: ConnectedBus | null = null;
  private remoteDesktop: PortalInterface | null = null;
  private portalSession: string | null = null;
  private portalReady: Promise<void> | null = null;
  private deliveryInFlight = false;

  constructor(
    private readonly getRestoreToken: () => string | null = () => null,
    private readonly saveRestoreToken: (token: string) => void = () =>
      undefined,
    private readonly io: PasteIo = {},
  ) {
    this.platform = io.platform ?? process.platform;
    this.env = io.env ?? process.env;
    this.waylandPortal =
      this.platform === "linux" &&
      this.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland";
    this.kdeWayland =
      this.waylandPortal &&
      /(?:^|:)KDE(?:$|:)/i.test(this.env.XDG_CURRENT_DESKTOP ?? "");
    this.qdbus = this.exists("qdbus6")
      ? "qdbus6"
      : this.exists("qdbus")
        ? "qdbus"
        : null;
    this.command = this.resolveCommand();
  }

  private exists(program: string): boolean {
    const command = this.platform === "win32" ? "where" : "which";
    return (
      (this.io.spawnSync ?? spawnSync)(command, [program], {
        stdio: "ignore",
        windowsHide: true,
      }).status === 0
    );
  }

  private resolveCommand(
    shortcut: PasteShortcut = "standard",
  ): PasteCommand | null {
    if (this.platform === "darwin") {
      return {
        program: "osascript",
        args: [
          "-e",
          'tell application "System Events" to keystroke "v" using command down',
        ],
      };
    }
    if (this.platform === "win32") {
      return {
        program: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${shortcut === "terminal" ? "^+v" : "^v"}')`,
        ],
      };
    }
    if (this.exists("xdotool"))
      return {
        program: "xdotool",
        args: [
          "key",
          "--clearmodifiers",
          shortcut === "terminal" ? "ctrl+shift+v" : "ctrl+v",
        ],
      };
    return null;
  }

  copy(text: string): void {
    this.clipboardRestore.cancel();
    this.publishClipboard(text);
  }

  private publishClipboard(text: string): void {
    clipboard.writeText(text);
    // Native-Wayland Electron can retain clipboard ownership without Klipper
    // observing the new text, causing Ctrl+V in another app to paste the
    // previous clipboard item. Publish through Plasma's clipboard service as
    // well so the destination sees the transcript after focus has moved.
    if (this.kdeWayland && this.qdbus) {
      const result = (this.io.spawnSync ?? spawnSync)(
        this.qdbus,
        ["org.kde.klipper", "/klipper", "setClipboardContents", text],
        {
          encoding: "utf8",
          windowsHide: true,
        },
      );
      if (result.status !== 0)
        throw new Error(
          result.stderr.trim() || "KDE clipboard rejected the transcript",
        );
    }
  }

  async authorize(): Promise<void> {
    if (!this.waylandPortal) return;
    await this.ensurePortalSession();
  }

  async paste(text: string, restoreClipboard = false): Promise<string> {
    if (this.deliveryInFlight) throw new Error("A paste is already in progress; wait before pasting again");
    this.deliveryInFlight = true;
    try { return await this.performPaste(text, restoreClipboard); }
    finally { this.deliveryInFlight = false; }
  }

  private async performPaste(text: string, restoreClipboard = false): Promise<string> {
    const shortcut = this.io.getShortcut?.() ?? "standard";
    const prepareRestore = this.clipboardRestore.begin(restoreClipboard, (previous) => this.copy(previous));
    const generation = this.clipboardRestore.generation;
    try { this.publishClipboard(text); } catch (error) { throw new ClipboardCopyError(error); }
    const finishRestore = prepareRestore?.();
    try {
    if (this.platform === "darwin") {
      const accessibility = getAccessibilityPermission(this.platform);
      if (!accessibility.canAttemptPaste)
        throw new Error(`The transcript was copied; ${accessibility.detail}`);
    }
    if (this.waylandPortal) {
      await this.pasteThroughPortal(shortcut);
      finishRestore?.();
      return "wayland-portal";
    }
    const command = this.resolveCommand(shortcut);
    if (!command)
      throw new Error(
        "no compatible input injector is available; the transcript is on the clipboard",
      );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    await new Promise<void>((resolvePaste, reject) => {
      const child = (this.io.spawn ?? spawn)(command.program, command.args, {
        windowsHide: true,
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      if (command.input) child.stdin.end(command.input);
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolvePaste()
          : reject(
              new Error(
                stderr.trim() ||
                  `${command.program} exited with code ${code}`,
              ),
            ),
      );
    });
    finishRestore?.();
    return command.program;
    } catch (error) {
      if (generation === this.clipboardRestore.generation) this.clipboardRestore.cancel();
      throw error;
    }
  }

  private async pasteThroughPortal(shortcut: PasteShortcut): Promise<void> {
    await this.ensurePortalSession();
    if (!this.remoteDesktop || !this.portalSession)
      throw new Error("Wayland paste permission is unavailable");
    const remoteDesktop = this.remoteDesktop;
    const session = this.portalSession;
    // Let the portal dialog close and restore focus before emitting paste.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 220));
    const keys = [KEYSYM_LEFTCTRL];
    if (shortcut === "terminal") keys.push(KEYSYM_LEFTSHIFT);
    keys.push(KEYSYM_V);
    const heldKeys: number[] = [];
    let pressFailed = false;
    try {
      for (const keysym of keys) {
        // A rejected notification may still have reached the compositor.
        heldKeys.push(keysym);
        await remoteDesktop.NotifyKeyboardKeysym(session, {}, keysym, 1);
      }
    } catch (error) {
      pressFailed = true;
      throw error;
    } finally {
      let releaseFailed = false;
      let releaseError: unknown;
      for (const keysym of heldKeys.reverse()) {
        try {
          await remoteDesktop.NotifyKeyboardKeysym(session, {}, keysym, 0);
        } catch (error) {
          if (!releaseFailed) releaseError = error;
          releaseFailed = true;
        }
      }
      // Attempt every release without masking the original injection failure.
      if (!pressFailed && releaseFailed) throw releaseError;
    }
  }

  private ensurePortalSession(): Promise<void> {
    if (this.remoteDesktop && this.portalSession) return Promise.resolve();
    if (this.portalReady) return this.portalReady;
    this.portalReady = this.openPortalSession()
      .catch(async (error) => {
        await this.closePortal();
        throw error;
      })
      .finally(() => {
        this.portalReady = null;
      });
    return this.portalReady;
  }

  private async openPortalSession(): Promise<void> {
    const busAddress = compatibleSessionBusAddress(this.env);
    const bus = sessionBus(
      busAddress ? { busAddress } : undefined,
    ) as ConnectedBus;
    this.bus = bus;
    const object = await bus.getProxyObject(PORTAL_NAME, PORTAL_PATH);
    try {
      await (
        object.getInterface(
          "org.freedesktop.host.portal.Registry",
        ) as PortalInterface
      ).Register(APP_ID, {});
    } catch {
      /* A recognized packaged application does not need host registration. */
    }
    const remoteDesktop = object.getInterface(
      "org.freedesktop.portal.RemoteDesktop",
    ) as PortalInterface;
    this.remoteDesktop = remoteDesktop;
    const token = `delulu_paste_${process.pid}_${Date.now()}`;
    const [createCode, createResults] = await portalRequest(
      bus,
      `${token}_create`,
      (handleToken) =>
        remoteDesktop.CreateSession({
          handle_token: new Variant("s", handleToken),
          session_handle_token: new Variant("s", `${token}_session`),
        }) as Promise<string>,
    );
    if (createCode !== 0)
      throw new Error(
        createCode === 1
          ? "Automatic paste permission was cancelled"
          : "Could not create a Wayland paste session",
      );
    const session = String(variantValue(createResults.session_handle) ?? "");
    if (!session)
      throw new Error("The Wayland portal returned no paste session");
    this.portalSession = session;

    const restoreToken = this.getRestoreToken();
    const selectOptions: Record<string, Variant> = {
      handle_token: new Variant("s", `${token}_select`),
      types: new Variant("u", KEYBOARD),
      persist_mode: new Variant("u", 2),
    };
    if (restoreToken)
      selectOptions.restore_token = new Variant("s", restoreToken);
    const [selectCode] = await portalRequest(
      bus,
      `${token}_select`,
      (handleToken) => {
        selectOptions.handle_token = new Variant("s", handleToken);
        return remoteDesktop.SelectDevices(
          session,
          selectOptions,
        ) as Promise<string>;
      },
    );
    if (selectCode !== 0)
      throw new Error(
        selectCode === 1
          ? "Automatic paste permission was cancelled"
          : "Keyboard control was not approved",
      );

    const [startCode, startResults] = await portalRequest(
      bus,
      `${token}_start`,
      (handleToken) =>
        remoteDesktop.Start(session, "", {
          handle_token: new Variant("s", handleToken),
        }) as Promise<string>,
    );
    if (startCode !== 0)
      throw new Error(
        startCode === 1
          ? "Automatic paste permission was cancelled"
          : "Could not start automatic paste",
      );
    const devices = Number(variantValue(startResults.devices) ?? 0);
    if ((devices & KEYBOARD) === 0)
      throw new Error(
        "Keyboard control was not granted; the transcript remains on the clipboard",
      );
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
      } catch {
        /* Disconnecting also closes the session. */
      }
    }
    bus?.disconnect();
  }

  shutdown(): void {
    this.clipboardRestore.cancel();
    void this.closePortal();
  }

  capabilities(
    overlayMethod: PlatformCapabilities["overlayMethod"] = "unavailable",
    overlayDetail?: string,
  ): PlatformCapabilities {
    const sessionType = this.env.XDG_SESSION_TYPE?.toLowerCase() ?? "unknown";
    return {
      platform: this.platform as PlatformCapabilities["platform"],
      desktop:
        this.env.XDG_CURRENT_DESKTOP ?? this.env.DESKTOP_SESSION ?? "unknown",
      sessionType,
      pasteMethod: this.waylandPortal
        ? "wayland-portal"
        : (this.command?.program ?? "clipboard-only"),
      overlayMethod,
      overlayDetail,
      wayland: sessionType === "wayland",
    };
  }
}
