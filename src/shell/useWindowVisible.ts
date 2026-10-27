import { useEffect, useState } from "react";
import { bridge } from "../bridge";

/** False while the desktop window is hidden to the tray or the document is hidden. */
export function useWindowVisible() {
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    let desktopVisible = true;
    let received = false;
    let mounted = true;
    const change = () => setVisible(desktopVisible && !document.hidden);
    const remove = bridge.onWindowVisibility((value) => {
      received = true;
      desktopVisible = value;
      change();
    });
    void bridge
      .getWindowVisibility()
      .then((value) => {
        if (!mounted || received) return;
        desktopVisible = value;
        change();
      })
      .catch(() => {});
    document.addEventListener("visibilitychange", change);
    return () => {
      mounted = false;
      remove();
      document.removeEventListener("visibilitychange", change);
    };
  }, []);
  return visible;
}
