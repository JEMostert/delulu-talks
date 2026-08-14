import { describe, expect, test } from "bun:test";
import { compatibleSessionBusAddress } from "./compat";

describe("Node compatibility", () => {
  test("routes dbus-next through Node net.Socket instead of legacy usocket", () => {
    expect(compatibleSessionBusAddress({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" })).toBe("unix:socket=/run/user/1000/bus");
    expect(compatibleSessionBusAddress({ DBUS_SESSION_BUS_ADDRESS: "tcp:host=localhost,port=123;unix:path=/tmp/bus" })).toBe("tcp:host=localhost,port=123;unix:socket=/tmp/bus");
  });

  test("derives the standard systemd user bus from XDG_RUNTIME_DIR", () => {
    expect(compatibleSessionBusAddress({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("unix:socket=/run/user/1000/bus");
    expect(compatibleSessionBusAddress({})).toBeUndefined();
  });
});
