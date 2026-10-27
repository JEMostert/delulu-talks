import { useEffect } from "react";
import { isTransientNotice, noticeTone } from "../helpers";
import { Icon } from "./Icon";

/** Messages float up from the bottom edge, like the recording pill. */
export function Toast({
  notice,
  onDismiss,
}: {
  notice: string;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!notice || !isTransientNotice(notice)) return;
    const timer = setTimeout(onDismiss, 3200);
    return () => clearTimeout(timer);
  }, [notice, onDismiss]);
  if (!notice) return null;
  const tone = noticeTone(notice);
  return (
    <div
      className={`toast toast-${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <span className="toast-dot" aria-hidden="true" />
      <span className="toast-text">{notice}</span>
      <button type="button" aria-label="Dismiss message" onClick={onDismiss}>
        <Icon name="close" size={15} />
      </button>
    </div>
  );
}
