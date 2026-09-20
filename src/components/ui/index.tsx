import { useEffect, useId, useRef, type ReactNode } from "react";
import { AlertCircle, X, type LucideIcon } from "lucide-react";

export function Toggle({
  value,
  label,
  onChange,
  disabled,
}: {
  value: boolean;
  label: string;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`toggle ${value ? "on" : ""}`}
      role="switch"
      aria-checked={value}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
    >
      <i />
    </button>
  );
}

export function SettingRow({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      {Icon && <Icon className="setting-icon" />}
      <div className="setting-copy">
        <strong>{title}</strong>
        {description && <p>{description}</p>}
      </div>
      <div className="setting-control max-[900px]:max-w-[47%] max-[700px]:max-w-full">
        {children}
      </div>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function Alert({
  children,
  action,
  onDismiss,
}: {
  children: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className="alert" role="alert">
      <AlertCircle />
      <div>{children}</div>
      {action}
      {onDismiss && (
        <button
          className="icon-button"
          aria-label="Dismiss message"
          onClick={onDismiss}
        >
          <X />
        </button>
      )}
    </div>
  );
}

/** Native modal supplies focus containment, Escape handling and focus restoration. */
export function Modal({
  title,
  children,
  onClose,
  footer,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current && !busy) {
          const box = ref.current.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            onClose();
        }
      }}
    >
      <header>
        <h2 id={id}>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          disabled={busy}
          onClick={onClose}
        >
          <X />
        </button>
      </header>
      <div className="modal-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </dialog>
  );
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="secondary-button" onClick={onClose} autoFocus>
            Cancel
          </button>
          <button
            className="danger-button"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
