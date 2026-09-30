import { previewApi } from "./preview";
import type { DeluluApi } from "./types";
import { restoreDomainError } from "./domainErrors";

const api = window.delulu ?? previewApi;
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
