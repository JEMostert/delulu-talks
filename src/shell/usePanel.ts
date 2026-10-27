import { useEffect, useRef } from "react";
import type { Page } from "../types";
import type { Workspace } from "./workspace";

/** The pearl, or the first dock item while the pearl is disabled (busy). */
export function homeFocusTarget() {
  return (
    document.querySelector<HTMLElement>(".ocean-record:not(:disabled)") ??
    document.querySelector<HTMLElement>(".dock-item")
  );
}

/**
 * The sheet over the ocean: open whenever a page other than Home is shown.
 * Focus moves into the sheet when it opens and back to the pearl when it
 * closes; Escape closes it unless a dialog is open.
 */
export function usePanel(w: Workspace) {
  const open = w.page !== "home";
  const ref = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  const onboardingShown = useRef(false);

  useEffect(() => {
    document
      .getElementById("page-content")
      ?.scrollTo({ top: 0, behavior: "instant" });
    w.operations.hideRewrite();
  }, [w.page]);

  useEffect(() => {
    if (w.ready && !w.settings.onboardingComplete && !onboardingShown.current) {
      onboardingShown.current = true;
      if (w.status.engine === "missing") w.setPage("models");
    }
  }, [w.ready, w.settings.onboardingComplete, w.status.engine]);

  const close = () => {
    w.setPage("home");
    if (!w.settings.onboardingComplete) void w.finishOnboarding(false);
  };
  const navigate = (page: Page) => w.setPage(page);

  useEffect(() => {
    // Tracked outside the frame: a quick Escape can cancel the opening frame.
    const closing = wasOpen.current && !open;
    wasOpen.current = open;
    const frame = requestAnimationFrame(() => {
      if (open) {
        ref.current?.focus({ preventScroll: true });
        const content = document.getElementById("page-content");
        if (content) content.scrollTop = 0;
      } else if (closing) homeFocusTarget()?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, w.page]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        !open ||
        document.querySelector(
          'dialog[open], [role="dialog"][aria-modal="true"]',
        )
      )
        return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  });

  return { open, ref, close, navigate };
}
