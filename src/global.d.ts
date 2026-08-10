import type { DeluluApi } from "./types";

declare global {
  interface Window {
    delulu?: DeluluApi;
  }
}

export {};
