import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
import { readStartupService } from "../startupServices";
import type {
  DictationStatus,
  MagicStatus,
  PlatformCapabilities,
  ShortcutStatus,
  UpdateStatus,
} from "../types";

export type RecoveryService =
  "speech" | "rewriting" | "shortcut" | "platform" | "updates";
export const serviceNames: Record<RecoveryService, string> = {
  speech: "Speech",
  rewriting: "Rewriting",
  shortcut: "Shortcut",
  platform: "Platform capabilities",
  updates: "Updates",
};
type Receivers = {
  speech: (value: DictationStatus) => void;
  rewriting: (value: MagicStatus) => void;
  shortcut: (value: ShortcutStatus) => void;
  platform: (value: PlatformCapabilities) => void;
  updates: (value: UpdateStatus) => void;
};

/** Retry optional status reads without replacing workspace data or subscriptions. */
export function useServiceRecovery(receivers: Receivers) {
  const currentReceivers = useRef(receivers);
  currentReceivers.current = receivers;
  const mounted = useRef(false);
  const pending = useRef(new Map<RecoveryService, AbortController>());
  const [errors, setErrors] = useState<
    Partial<Record<RecoveryService, string>>
  >({});
  const [retrying, setRetrying] = useState<
    Partial<Record<RecoveryService, boolean>>
  >({});
  const cancel = useCallback(() => {
    for (const controller of pending.current.values()) controller.abort();
    pending.current.clear();
    if (mounted.current) setRetrying({});
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel();
    };
  }, [cancel]);
  const failed = useCallback((service: RecoveryService, reason: unknown) => {
    if (!mounted.current) return;
    const message = reason instanceof Error ? reason.message : String(reason);
    setErrors((previous) => ({
      ...previous,
      [service]: message.replace(
        "Retry opening the workspace.",
        "Retry this service.",
      ),
    }));
  }, []);
  const received = useCallback((service: RecoveryService) => {
    // A newer live event takes precedence over an outstanding status snapshot.
    pending.current.get(service)?.abort();
    pending.current.delete(service);
    if (!mounted.current) return;
    setRetrying((previous) => ({ ...previous, [service]: false }));
    setErrors((previous) => {
      const next = { ...previous };
      delete next[service];
      return next;
    });
  }, []);
  const retry = useCallback(
    async (service: RecoveryService) => {
      if (!mounted.current || pending.current.has(service)) return;
      const controller = new AbortController();
      pending.current.set(service, controller);
      setRetrying((previous) => ({ ...previous, [service]: true }));
      const requests: Record<RecoveryService, () => Promise<() => void>> = {
        speech: async () => {
          const value = await bridge.getStatus();
          return () => currentReceivers.current.speech(value);
        },
        rewriting: async () => {
          const value = await bridge.getMagicStatus();
          return () => currentReceivers.current.rewriting(value);
        },
        shortcut: async () => {
          const value = await bridge.getShortcutStatus();
          return () => currentReceivers.current.shortcut(value);
        },
        platform: async () => {
          const value = await bridge.getCapabilities();
          return () => currentReceivers.current.platform(value);
        },
        updates: async () => {
          const value = await bridge.getUpdateStatus();
          return () => currentReceivers.current.updates(value);
        },
      };
      try {
        const apply = await readStartupService(
          serviceNames[service],
          requests[service],
          controller.signal,
        );
        if (
          !mounted.current ||
          controller.signal.aborted ||
          pending.current.get(service) !== controller
        )
          return;
        apply();
        received(service);
      } catch (reason) {
        if (!controller.signal.aborted) failed(service, reason);
      } finally {
        if (pending.current.get(service) === controller) {
          pending.current.delete(service);
          if (mounted.current)
            setRetrying((previous) => ({ ...previous, [service]: false }));
        }
      }
    },
    [failed, received],
  );
  return { errors, retrying, retry, failed, received, cancel };
}
