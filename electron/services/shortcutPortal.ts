import { Message, MessageType, type MessageBus, type Variant } from "dbus-next";

export const PORTAL_NAME = "org.freedesktop.portal.Desktop";
export const PORTAL_PATH = "/org/freedesktop/portal/desktop";

type ConnectedBus = MessageBus & { name: string | null };
type PortalResult = [number, Record<string, Variant>];

function matchCall(member: "AddMatch" | "RemoveMatch", rule: string): Message {
  return new Message({
    destination: "org.freedesktop.DBus",
    path: "/org/freedesktop/DBus",
    interface: "org.freedesktop.DBus",
    member,
    signature: "s",
    body: [rule],
  });
}

async function connected(bus: ConnectedBus): Promise<void> {
  if (bus.name) return;
  await new Promise<void>((resolve, reject) => {
    const ready = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => {
      bus.off("connect", ready);
      bus.off("error", failed);
    };
    bus.once("connect", ready);
    bus.once("error", failed);
  });
}

export function requestPath(sender: string, token: string): string {
  return `${PORTAL_PATH}/request/${sender.replace(/^:/, "").replaceAll(".", "_")}/${token}`;
}

/** Subscribe before invoking the portal method, as required by the Request protocol. */
export async function portalRequest(
  bus: ConnectedBus,
  token: string,
  invoke: (token: string) => Promise<string>,
  timeoutMs = 5 * 60_000,
): Promise<PortalResult> {
  await connected(bus);
  const expectedPath = requestPath(bus.name!, token);
  const rule = `type='signal',sender='${PORTAL_NAME}',path='${expectedPath}',interface='org.freedesktop.portal.Request',member='Response'`;
  await bus.call(matchCall("AddMatch", rule));

  let timer: NodeJS.Timeout | undefined;
  let receive!: (message: Message) => void;
  const response = new Promise<PortalResult>((resolve, reject) => {
    receive = (message) => {
      if (message.type !== MessageType.SIGNAL || message.path !== expectedPath || message.interface !== "org.freedesktop.portal.Request" || message.member !== "Response") return;
      resolve(message.body as PortalResult);
    };
    bus.on("message", receive);
    timer = setTimeout(() => reject(new Error("The desktop shortcut portal did not respond")), timeoutMs);
  });

  try {
    const returnedPath = await invoke(token);
    if (returnedPath !== expectedPath) throw new Error(`Unsupported shortcut portal request path: ${returnedPath}`);
    return await response;
  } finally {
    if (timer) clearTimeout(timer);
    bus.off("message", receive);
    await bus.call(matchCall("RemoveMatch", rule)).catch(() => undefined);
  }
}
