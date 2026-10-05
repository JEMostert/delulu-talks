import { app } from "electron";
import type { RenderingMode } from "../../src/types";

/** WebGL availability does not establish whether window compositing is accelerated. */
export function getRenderingMode(): RenderingMode {
  return app.getGPUFeatureStatus().gpu_compositing?.startsWith("enabled")
    ? "hardware"
    : "software";
}
