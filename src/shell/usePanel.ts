import { useEffect, useRef, useState } from "react";
import type { Page } from "../types";
import type { Workspace } from "./workspace";

/**
 * The sheet over the ocean: quick settings on Home, or a page. Focus moves
 * into the sheet when it opens and back to the controller when it closes;
 * Escape closes it unless a dialog is open.
 */
export function usePanel(w: Workspace) {
  const [quickOpen, setQuickOpen] = useState(false);
  const open = quickOpen || w.page !== "home";
  const ref = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  const onboardingShown = useRef(false);

  useEffect(() => {
    if (w.page !== "home") setQuickOpen(false);
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
    setQuickOpen(false);
    w.setPage("home");
    if (!w.settings.onboardingComplete) void w.finishOnboarding(false);
  };
  const navigate = (page: Page) => {
    setQuickOpen(false);
    w.setPage(page);
  };
  const toggleQuick = () => {
    if (open) return close();
    w.setPage("home");
    setQuickOpen(true);
  };

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (open) {
        ref.current?.focus({ preventScroll: true });
        const content = document.getElementById("page-content");
        if (content) content.scrollTop = 0;
      } else if (wasOpen.current)
        document
          .querySelector<HTMLButtonElement>('[aria-label="Open settings"]')
          ?.focus();
      wasOpen.current = open;
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

  return {
    open,
    quick: quickOpen && w.page === "home",
    ref,
    close,
    navigate,
    toggleQuick,
  };
}
