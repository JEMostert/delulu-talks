import { previewApi } from "./preview";
import type { DeluluApi } from "./types";
import { restoreDomainError } from "./domainErrors";
import { installDesktopBridge } from "./desktopBridge";

// Inside Tauri the desktop bridge installs window.delulu. The browser preview
// mock is dev-only (dev:web and e2e); Vite replaces import.meta.env.DEV with
// false in production builds so it is tree-shaken.
const api: DeluluApi =
  window.delulu ??
  installDesktopBridge() ??
  (import.meta.env.DEV ? previewApi : missingBridge());
function missingBridge(): never {
  throw new Error("Delulu bridge is unavailable outside the desktop app.");
}
// Preserve subscription disposers and synchronous methods; only invocation
// promise rejections cross the error reconstruction boundary. The Tauri bridge
// already throws DomainErrors (restoring passes them through); the message
// marker is still honoured for any bridge that can only transport text.
// Proxy a mutable wrapper so wrapping a method cannot violate a frozen
// bridge object's non-configurable property invariants.
export const bridge: DeluluApi = new Proxy({} as DeluluApi, {
  get(target, property) {
    const method = Object.prototype.hasOwnProperty.call(target, property)
      ? Reflect.get(target, property)
      : Reflect.get(api, property, api);
    if (typeof method !== "function") return method;
    return (...args: unknown[]) => {
      const result = Reflect.apply(method, api, args);
      return result instanceof Promise
        ? result.catch((reason: unknown) => {
            throw restoreDomainError(reason);
          })
        : result;
    };
  },
});
