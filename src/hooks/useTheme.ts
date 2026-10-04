import { useEffect, useState } from "react";
import type { AppSettings } from "../types";

/** Applies the theme to the document and returns the resolved light/dark value. */
export function useTheme(theme: AppSettings["theme"]): "light" | "dark" {
  const [resolved, setResolved] = useState<"light" | "dark">(() =>
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const next =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = next;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", next === "dark" ? "#071e34" : "#cfeaf4");
      setResolved(next);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return resolved;
}
