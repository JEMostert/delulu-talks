import { previewApi } from "./preview";
import type { DeluluApi } from "./types";
import { restoreDomainError } from "./domainErrors";

const api = window.delulu ?? previewApi;
// Preserve subscription disposers and synchronous methods; only invocation
// promise rejections cross the error reconstruction boundary.
export const bridge: DeluluApi = new Proxy(api, {
  get(target, property, receiver) {
    const method = Reflect.get(target, property, receiver);
    if (typeof method !== "function") return method;
    return (...args: unknown[]) => {
      const result = Reflect.apply(method, target, args);
      return result instanceof Promise
        ? result.catch((reason: unknown) => { throw restoreDomainError(reason); })
        : result;
    };
  },
});
