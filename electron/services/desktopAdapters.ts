import type {
  AccessibilityPermission,
  PlatformCapabilities,
  ShortcutStatus,
} from "../../src/types";
import { getAccessibilityPermission } from "./accessibilityPermission";
import { PasteService } from "./paste";
import { PillService, type PillCommand } from "./pill";
import { ShortcutService } from "./shortcut";

export interface DesktopPasteAdapter {
  readonly isBusy: boolean;
  withClipboardLease<T>(operation: () => Promise<T>): Promise<T>;
  copy(text: string, timings?: import("../../src/types").PipelineTimings): void;
  paste(
    text: string,
    restoreClipboard?: boolean,
    timings?: import("../../src/types").PipelineTimings,
  ): Promise<string>;
  authorize(): Promise<void>;
  capabilities(
    overlayMethod?: PlatformCapabilities["overlayMethod"],
    overlayDetail?: string,
  ): PlatformCapabilities;
  shutdown(): void;
}

export interface DesktopShortcutAdapter {
  register(accelerator: string): Promise<void>;
  change<T>(
    accelerator: string,
    previousAccelerator: string,
    persist: () => T,
  ): Promise<T>;
  configure(): Promise<void>;
  getStatus(): ShortcutStatus;
  onStatus(listener: (status: ShortcutStatus) => void): () => void;
  shutdown(): Promise<void>;
}

export interface DesktopIndicatorAdapter {
  readonly method: PlatformCapabilities["overlayMethod"];
  readonly detail: string;
  prepare(): void;
  show(
    command: Omit<PillCommand, "state"> & {
      state: Exclude<PillCommand["state"], "hidden">;
    },
  ): void;
  hide(): void;
  level(value: number): void;
  shutdown(): void;
}

export interface DesktopPermissionAdapter {
  accessibility(): AccessibilityPermission;
}

export function createPasteAdapter(
  ...args: ConstructorParameters<typeof PasteService>
): DesktopPasteAdapter {
  return new PasteService(...args);
}

export function createShortcutAdapter(
  ...args: ConstructorParameters<typeof ShortcutService>
): DesktopShortcutAdapter {
  return new ShortcutService(...args);
}

export function createIndicatorAdapter(
  ...args: ConstructorParameters<typeof PillService>
): DesktopIndicatorAdapter {
  return new PillService(...args);
}

export function createPermissionAdapter(
  platform: NodeJS.Platform = process.platform,
): DesktopPermissionAdapter {
  return { accessibility: () => getAccessibilityPermission(platform) };
}
