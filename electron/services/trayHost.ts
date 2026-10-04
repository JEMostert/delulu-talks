import { sessionBus, type MessageBus } from "dbus-next";
import { compatibleSessionBusAddress } from "../compat";

/**
 * Linux trays need a StatusNotifier host (KDE, most desktops, or GNOME with
 * the AppIndicator extension). Without one the icon is invisible.
 */
export async function linuxTrayHostAvailable(
  timeoutMs = 1500,
): Promise<boolean> {
  if (process.platform !== "linux") return true;
  let bus: MessageBus | null = null;
  try {
    const address = compatibleSessionBusAddress(process.env);
    bus = sessionBus(address ? { busAddress: address } : undefined);
    bus.on("error", () => undefined);
    const object = await bus.getProxyObject(
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
    );
    const dbus = object.getInterface("org.freedesktop.DBus") as unknown as {
      NameHasOwner(name: string): Promise<boolean>;
    };
    return await Promise.race([
      dbus.NameHasOwner("org.kde.StatusNotifierWatcher"),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(true), timeoutMs),
      ),
    ]);
  } catch {
    // Unknown: assume a tray exists rather than changing close behaviour.
    return true;
  } finally {
    bus?.disconnect();
  }
}
