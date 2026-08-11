import { globalShortcut } from "electron";
import { sessionBus, Variant, type ClientInterface, type MessageBus } from "dbus-next";
import type { ShortcutStatus } from "../../src/types";
import { portalTrigger } from "./shortcutFormat";

const PORTAL_NAME = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const SHORTCUT_ID = "toggle-dictation";

type PortalInterface = ClientInterface & Record<string, (...args: unknown[]) => Promise<unknown>>;

function portalError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^.*?:\s*/, "").split(/\r?\n/)[0].slice(0, 240);
}

async function portalResponse(bus: MessageBus, requestPath: string): Promise<[number, Record<string, Variant>]> {
  const requestObject = await bus.getProxyObject(PORTAL_NAME, requestPath);
  const request = requestObject.getInterface("org.freedesktop.portal.Request");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The desktop shortcut portal did not respond")), 60_000);
    request.once("Response", (code: number, results: Record<string, Variant>) => {
      clearTimeout(timer);
      resolve([code, results]);
    });
  });
}

export class ShortcutService {
  private status: ShortcutStatus;
  private listeners = new Set<(status: ShortcutStatus) => void>();
  private portalBus: MessageBus | null = null;
  private portalSession: string | null = null;
  private portalInterface: PortalInterface | null = null;

  constructor(private readonly onTrigger: () => void) {
    const portal = process.platform === "linux" && process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland";
    this.status = {
      accelerator: "CommandOrControl+Shift+Space",
      registered: false,
      method: portal ? "portal" : "native",
      message: "Shortcut registration pending",
      lastTriggeredAt: null,
    };
  }

  onStatus(listener: (status: ShortcutStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStatus(): ShortcutStatus {
    return structuredClone(this.status);
  }

  private update(patch: Partial<ShortcutStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener(this.getStatus());
  }

  private trigger(): void {
    this.update({ registered: true, message: "Shortcut triggered", lastTriggeredAt: Date.now() });
    this.onTrigger();
  }

  async register(accelerator: string): Promise<void> {
    if (this.status.method === "portal") await this.registerPortal(accelerator);
    else this.registerNative(accelerator);
  }

  private registerNative(accelerator: string): void {
    globalShortcut.unregisterAll();
    if (!globalShortcut.register(accelerator, () => this.trigger())) {
      this.update({ accelerator, registered: false, message: "Shortcut unavailable — choose another combination" });
      throw new Error(`Global shortcut '${accelerator}' is unavailable`);
    }
    this.update({ accelerator, registered: true, message: "System shortcut ready" });
  }

  private async registerPortal(accelerator: string): Promise<void> {
    await this.closePortal();
    this.update({ accelerator, registered: false, message: "Waiting for the Wayland shortcut portal" });
    const bus = sessionBus();
    this.portalBus = bus;
    bus.on("error", (error) => this.update({ registered: false, message: `Shortcut portal error: ${portalError(error)}` }));
    try {
      const portalObject = await bus.getProxyObject(PORTAL_NAME, PORTAL_PATH);
      try {
        const registry = portalObject.getInterface("org.freedesktop.host.portal.Registry") as PortalInterface;
        await registry.Register("delulu-talks", {});
      } catch {
        // Sandboxed/package-managed apps already have a portal identity.
      }

      const shortcuts = portalObject.getInterface("org.freedesktop.portal.GlobalShortcuts") as PortalInterface;
      this.portalInterface = shortcuts;
      const token = `delulu_${process.pid}_${Date.now()}`;
      const createPath = await shortcuts.CreateSession({
        handle_token: new Variant("s", `${token}_create`),
        session_handle_token: new Variant("s", `${token}_session`),
      }) as string;
      const [createCode, createResults] = await portalResponse(bus, createPath);
      if (createCode !== 0) throw new Error(createCode === 1 ? "Shortcut permission was cancelled" : "The shortcut portal could not create a session");
      const sessionHandle = createResults.session_handle?.value as string | undefined;
      if (!sessionHandle) throw new Error("The shortcut portal returned no session");
      this.portalSession = sessionHandle;

      shortcuts.on("Activated", (session: string, id: string) => {
        if (session === this.portalSession && id === SHORTCUT_ID) this.trigger();
      });
      const bindPath = await shortcuts.BindShortcuts(
        sessionHandle,
        [[SHORTCUT_ID, {
          description: new Variant("s", "Start or stop dictation"),
          preferred_trigger: new Variant("s", portalTrigger(accelerator)),
        }]],
        "",
        { handle_token: new Variant("s", `${token}_bind`) },
      ) as string;
      const [bindCode, bindResults] = await portalResponse(bus, bindPath);
      if (bindCode !== 0) throw new Error(bindCode === 1 ? "Shortcut permission was cancelled" : "The shortcut portal rejected the binding");
      const bound = bindResults.shortcuts?.value as Array<[string, Record<string, Variant>]> | undefined;
      const triggerDescription = bound?.find(([id]) => id === SHORTCUT_ID)?.[1]?.trigger_description?.value as string | undefined;
      this.update({ accelerator, registered: true, message: triggerDescription ? `Wayland portal ready · ${triggerDescription}` : "Ready through the Wayland shortcut portal" });
    } catch (error) {
      await this.closePortal();
      this.update({ accelerator, registered: false, message: `Shortcut unavailable: ${portalError(error)}` });
      throw error;
    }
  }

  private async closePortal(): Promise<void> {
    const bus = this.portalBus;
    const session = this.portalSession;
    this.portalSession = null;
    this.portalInterface = null;
    this.portalBus = null;
    if (bus && session) {
      try {
        const sessionObject = await bus.getProxyObject(PORTAL_NAME, session);
        await sessionObject.getInterface("org.freedesktop.portal.Session").Close();
      } catch {
        // Closing is best effort; disconnecting also destroys the portal session.
      }
    }
    bus?.disconnect();
  }

  async shutdown(): Promise<void> {
    globalShortcut.unregisterAll();
    await this.closePortal();
    this.update({ registered: false, message: "Shortcut stopped" });
  }
}
