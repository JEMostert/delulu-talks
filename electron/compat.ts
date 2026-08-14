/**
 * dbus-next prefers its optional native `usocket` module for `unix:path=`
 * addresses. usocket calls the removed Node `util.isError` API. The equivalent
 * `unix:socket=` form deliberately uses Node's maintained net.Socket instead.
 */
export function compatibleSessionBusAddress(env: NodeJS.ProcessEnv): string | undefined {
  const address = env.DBUS_SESSION_BUS_ADDRESS
    ?? (env.XDG_RUNTIME_DIR ? `unix:path=${env.XDG_RUNTIME_DIR}/bus` : undefined);
  if (!address) return undefined;
  return address.split(";").map((entry) => entry.replace(/^unix:path=/, "unix:socket=")).join(";");
}
