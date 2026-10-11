import { previewApi } from "./preview";
import type { DeluluApi } from "./types";
import { restoreDomainError } from "./domainErrors";

// The browser preview mock is dev-only (dev:web and e2e); Vite replaces
// import.meta.env.DEV with false in production builds so it is tree-shaken.
const api: DeluluApi =
  window.delulu ?? (import.meta.env.DEV ? previewApi : missingBridge());
function missingBridge(): never {
  throw new Error("Delulu bridge is unavailable outside the Electron preload.");
}
// Preserve subscription disposers and synchronous methods; only invocation
// promise rejections cross the error reconstruction boundary.
// contextBridge freezes its exports. Proxy a mutable wrapper so wrapping a method
// cannot violate the original object's non-configurable property invariants.
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
