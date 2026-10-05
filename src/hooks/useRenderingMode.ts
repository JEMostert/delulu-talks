import { useEffect } from "react";
import { bridge } from "../bridge";
import type { RenderingMode } from "../types";

/** Start with inexpensive drawing until the native compositor reports its status. */
export function useRenderingMode() {
  useEffect(() => {
    let active = true;
    let updated = false;
    const apply = (mode: RenderingMode) => {
      if (active) document.documentElement.dataset.rendering = mode;
    };
    const unsubscribe = bridge.onRenderingModeChanged((mode) => {
      updated = true;
      apply(mode);
    });
    void bridge.getRenderingMode().then(
      (mode) => {
        if (!updated) apply(mode);
      },
      () => {
        if (!updated) apply("software");
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
}
