import { globalShortcut } from "electron";
import { sessionBus, Variant, type ClientInterface, type MessageBus } from "dbus-next";
import { DEFAULT_SHORTCUT } from "../../src/data";
import type { ShortcutStatus } from "../../src/types";
import { portalTrigger } from "./shortcutFormat";
import { portalRequest, PORTAL_NAME, PORTAL_PATH } from "./shortcutPortal";
import { ShortcutGesture, type ShortcutActions, type ShortcutMode } from "./shortcutGesture";
import { compatibleSessionBusAddress } from "../compat";

const APP_ID = "delulu-talks";
const SHORTCUT_ID = "toggle-dictation";
type PortalInterface = ClientInterface & Record<string, (...args: unknown[]) => Promise<unknown>>;

function concise(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0].slice(0, 240);
}

function shortcutDescription(shortcuts: unknown): string | undefined {
  const entries = shortcuts instanceof Variant ? shortcuts.value : shortcuts;
  if (!Array.isArray(entries)) return undefined;
  const properties = entries.find((entry) => Array.isArray(entry) && entry[0] === SHORTCUT_ID)?.[1];
  const description = properties?.trigger_description;
  return description instanceof Variant ? String(description.value) : description ? String(description) : undefined;
}

export class ShortcutService {
  private readonly portal = process.platform === "linux" && process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland";
  private status: ShortcutStatus = {
    accelerator: DEFAULT_SHORTCUT,
    registered: false,
    method: this.portal ? "portal" : "native",
    message: "Shortcut registration pending",
    lastTriggeredAt: null,
  };
  private listeners = new Set<(status: ShortcutStatus) => void>();
  private bus: MessageBus | null = null;
  private session: string | null = null;
  private shortcuts: PortalInterface | null = null;
  private readonly gesture: ShortcutGesture;

  constructor(mode: () => ShortcutMode, actions: ShortcutActions) {
    this.gesture = new ShortcutGesture(mode, actions);
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

  private press(): void {
    this.update({ registered: true, message: "Shortcut active", lastTriggeredAt: Date.now() });
    this.gesture.press(true);
  }

  private release(): void {
    this.update({ message: "Shortcut ready" });
    this.gesture.release();
  }

  async register(accelerator: string): Promise<void> {
    if (this.portal) await this.registerPortal(accelerator);
    else this.registerNative(accelerator);
  }

  private registerNative(accelerator: string): void {
    globalShortcut.unregisterAll();
    if (!globalShortcut.register(accelerator, () => {
      this.update({ registered: true, message: "Shortcut triggered", lastTriggeredAt: Date.now() });
      this.gesture.press(false);
    })) {
      this.update({ accelerator, registered: false, message: "Shortcut unavailable — choose another combination" });
      throw new Error(`Global shortcut '${accelerator}' is unavailable`);
    }
    this.update({ accelerator, registered: true, message: "System shortcut ready" });
  }

  private async registerPortal(accelerator: string): Promise<void> {
    await this.closePortal();
    this.update({ accelerator, registered: false, message: "Registering with the desktop shortcut portal" });
    const busAddress = compatibleSessionBusAddress(process.env);
    const bus = sessionBus(busAddress ? { busAddress } : undefined) as MessageBus & { name: string | null };
    this.bus = bus;
    bus.on("error", (error) => this.update({ registered: false, message: `Shortcut portal error: ${concise(error)}` }));
    try {
      const object = await bus.getProxyObject(PORTAL_NAME, PORTAL_PATH);
      try {
        await (object.getInterface("org.freedesktop.host.portal.Registry") as PortalInterface).Register(APP_ID, {});
      } catch { /* Packaged apps already have a portal identity. */ }
      const shortcuts = object.getInterface("org.freedesktop.portal.GlobalShortcuts") as PortalInterface;
      this.shortcuts = shortcuts;
      shortcuts.on("Activated", (session: string, id: string) => { if (session === this.session && id === SHORTCUT_ID) this.press(); });
      shortcuts.on("Deactivated", (session: string, id: string) => { if (session === this.session && id === SHORTCUT_ID) this.release(); });
      shortcuts.on("ShortcutsChanged", (session: string, entries: unknown) => {
        if (session !== this.session) return;
        const description = shortcutDescription(entries);
        if (description) this.update({ accelerator: description, message: `Wayland shortcut ready · ${description}` });
      });

      const token = `delulu_${process.pid}_${Date.now()}`;
      const [createCode, createResults] = await portalRequest(bus, `${token}_create`, (handleToken) => shortcuts.CreateSession({
        handle_token: new Variant("s", handleToken),
        session_handle_token: new Variant("s", `${token}_session`),
      }) as Promise<string>);
      if (createCode !== 0) throw new Error(createCode === 1 ? "Shortcut permission was cancelled" : "The shortcut portal could not create a session");
      this.session = String(createResults.session_handle?.value ?? "");
      if (!this.session) throw new Error("The shortcut portal returned no session");

      const [bindCode, bindResults] = await portalRequest(bus, `${token}_bind`, (handleToken) => shortcuts.BindShortcuts(
        this.session,
        [[SHORTCUT_ID, {
          description: new Variant("s", "Dictation shortcut"),
          preferred_trigger: new Variant("s", portalTrigger(accelerator)),
        }]],
        "",
        { handle_token: new Variant("s", handleToken) },
      ) as Promise<string>);
      if (bindCode !== 0) throw new Error(bindCode === 1 ? "Shortcut permission was cancelled" : "The shortcut portal rejected the binding");
      const description = shortcutDescription(bindResults.shortcuts) ?? accelerator;
      this.update({ accelerator: description, registered: true, message: `Wayland shortcut ready · ${description}` });
    } catch (error) {
      await this.closePortal();
      this.update({ accelerator, registered: false, message: `Shortcut unavailable: ${concise(error)}` });
      throw error;
    }
  }

  async configure(): Promise<void> {
    if (!this.portal || !this.shortcuts || !this.session) throw new Error("The system shortcut editor is unavailable");
    await this.shortcuts.ConfigureShortcuts(this.session, "", {});
  }

  private async closePortal(): Promise<void> {
    const bus = this.bus;
    const session = this.session;
    this.bus = null;
    this.session = null;
    this.shortcuts = null;
    this.gesture.reset();
    if (bus && session) {
      try {
        const object = await bus.getProxyObject(PORTAL_NAME, session);
        await object.getInterface("org.freedesktop.portal.Session").Close();
      } catch { /* Disconnecting also destroys the session. */ }
    }
    bus?.disconnect();
  }

  async shutdown(): Promise<void> {
    globalShortcut.unregisterAll();
    await this.closePortal();
    this.update({ registered: false, message: "Shortcut stopped" });
  }
}
