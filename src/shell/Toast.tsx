import { Check, LoaderCircle, X } from "lucide-react";

export function Toast({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss: () => void;
}) {
  if (!message) return null;
  return (
    <div className="ocean-toast" role="status">
      {/…$|\.\.\.$/.test(message) ? (
        <LoaderCircle className="spin toast-pending" aria-hidden="true" />
      ) : (
        <Check aria-hidden="true" />
      )}
      <span>{message}</span>
      <button
        className="sheet-icon"
        aria-label="Dismiss notification"
        onClick={onDismiss}
      >
        <X />
      </button>
    </div>
  );
}
