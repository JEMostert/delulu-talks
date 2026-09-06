import { previewApi } from "./preview";
import type { DeluluApi } from "./types";

export const bridge: DeluluApi = window.delulu ?? previewApi;
