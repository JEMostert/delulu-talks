import { EventEmitter } from "node:events";
import { afterEach, expect, test } from "bun:test";
import { MessageType, type MessageBus } from "dbus-next";
import { ShortcutService } from "./shortcut";

// Fake portal bus: records how many buses are connected at the same time.
let openBuses = 0;
let maxOpenBuses = 0;
const sessions: string[] = [];

class FakeInterface extends EventEmitter {
  constructor(private readonly bus: FakeBus) {
    super();
  }

  Register = async () => undefined;
  ConfigureShortcuts = async () => undefined;
  Close = async () => undefined;

  CreateSession = async (options: { handle_token: { value: string } }) => {
    const session = `/session/${sessions.length + 1}`;
    sessions.push(session);
    this.respond(options.handle_token.value, [
      0,
      { session_handle: { value: session } },
    ]);
    return this.requestPath(options.handle_token.value);
  };

  BindShortcuts = async (
    _session: string,
    _shortcuts: unknown,
    _parent: string,
    options: { handle_token: { value: string } },
  ) => {
    this.respond(options.handle_token.value, [0, { shortcuts: [] }]);
    return this.requestPath(options.handle_token.value);
  };

  private requestPath(token: string): string {
    return `/org/freedesktop/portal/desktop/request/${this.bus.name.slice(1).replaceAll(".", "_")}/${token}`;
  }

  private respond(token: string, results: unknown[]): void {
    const path = this.requestPath(token);
    setTimeout(() => {
      this.bus.emit("message", {
        type: MessageType.SIGNAL,
        path,
        interface: "org.freedesktop.portal.Request",
        member: "Response",
        body: results,
      });
    }, 0);
  }
}

class FakeBus extends EventEmitter {
  readonly name: string;
  private disconnected = false;
  private readonly interfaces = new Map<string, FakeInterface>();

  constructor() {
    super();
    this.name = `:1.${openBuses + 1}`;
    openBuses++;
    maxOpenBuses = Math.max(maxOpenBuses, openBuses);
  }

  async getProxyObject(_name: string, _path: string) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      getInterface: (name: string) => {
        if (!this.interfaces.has(name))
          this.interfaces.set(name, new FakeInterface(this));
        return this.interfaces.get(name)!;
      },
    };
  }

  async call(): Promise<undefined> {
    return undefined;
  }

  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    openBuses--;
  }
}

const previousSessionType = process.env.XDG_SESSION_TYPE;
afterEach(() => {
  if (previousSessionType === undefined) delete process.env.XDG_SESSION_TYPE;
  else process.env.XDG_SESSION_TYPE = previousSessionType;
});

test.skipIf(process.platform !== "linux")(
  "register and change never hold two portal buses at once",
  async () => {
    process.env.XDG_SESSION_TYPE = "wayland";
    const service = new ShortcutService(
      () => "toggle",
      { start() {}, stop() {}, toggle() {} },
      () => new FakeBus() as unknown as MessageBus & { name: string | null },
    );

    // The startup register and a settings change can overlap in the app.
    const [, saved] = await Promise.all([
      service.register("Super+A"),
      service.change("Super+B", "Super+A", () => "saved"),
    ]);

    expect(saved).toBe("saved");
    expect(maxOpenBuses).toBe(1);
    expect(openBuses).toBe(1);
    expect(service.getStatus()).toMatchObject({
      accelerator: "Super+B",
      registered: true,
    });
  },
);
