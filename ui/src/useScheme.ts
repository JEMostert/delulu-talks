import { useEffect } from "react";
import type { Settings } from "./ipc";

/**
 * Resolves the theme setting to a concrete light or dark scheme on <html>, so
 * the stylesheet only needs one block of dark tokens.
 */
export function useScheme(theme: Settings["theme"] | undefined) {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme !== "light" && media.matches);
      document.documentElement.dataset.scheme = dark ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
}
