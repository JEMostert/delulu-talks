import { useEffect, useId, useRef, type ReactNode } from "react";
import type React from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
  type LucideIcon,
} from "lucide-react";

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
  help,
  children,
}: {
  icon?: LucideIcon;
  title: string;
  /** One short, always-visible line under the title. */
  description?: string;
  /** Longer guidance behind an info toggle. */
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      {Icon && <Icon className="setting-icon" aria-hidden="true" />}
      <div className="setting-copy">
        <strong>{title}</strong>
        {help && (
          <details className="setting-help">
            <summary aria-label={`About ${title}`} title={`About ${title}`}>
              <Info />
            </summary>
            <p>{help}</p>
          </details>
        )}
        {description && <p>{description}</p>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

/** Accessible tab strip: roving focus, arrow keys, Home/End. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
  className = "",
  trailing,
}: {
  tabs: readonly (readonly [T, string])[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  /** When set, tabs reference `${idPrefix}-panel` via aria-controls. */
  idPrefix?: string;
  className?: string;
  trailing?: ReactNode;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const move = (event: React.KeyboardEvent, index: number) => {
    const last = tabs.length - 1;
    const next =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    const [id] = tabs[next];
    onChange(id);
    refs.current.get(id)?.focus();
  };
  return (
    <div className={`page-tabs ${className}`} role="tablist" aria-label={label}>
      {tabs.map(([id, text], index) => (
        <button
          key={id}
          ref={(element) => {
            if (element) refs.current.set(id, element);
            else refs.current.delete(id);
          }}
          type="button"
          role="tab"
          id={idPrefix ? `${idPrefix}-tab-${id}` : undefined}
          aria-controls={idPrefix ? `${idPrefix}-panel` : undefined}
          aria-selected={value === id}
          tabIndex={value === id ? 0 : -1}
          className={value === id ? "active" : ""}
          onClick={() => onChange(id)}
          onKeyDown={(event) => move(event, index)}
        >
          {text}
        </button>
      ))}
      {trailing}
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

const ALERT_ICONS = {
  danger: AlertCircle,
  warning: AlertTriangle,
  info: Info,
  success: CheckCircle2,
} satisfies Record<string, LucideIcon>;

export function Alert({
  children,
  action,
  onDismiss,
  tone = "danger",
}: {
  children: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
  /** Danger interrupts assistive technology; other tones are polite status. */
  tone?: keyof typeof ALERT_ICONS;
}) {
  const Icon = ALERT_ICONS[tone];
  return (
    <div
      className={`alert ${tone === "danger" ? "" : tone}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      <Icon aria-hidden="true" />
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
  visible = true,
  size = "md",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  busy?: boolean;
  visible?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    if (visible) dialog?.showModal();
    else dialog?.close();
    return () => {
      dialog?.close();
      const visible = (element: HTMLElement | null): element is HTMLElement =>
        !!element?.isConnected &&
        !element.matches(":disabled") &&
        !element.closest("[hidden], [inert], [aria-hidden='true']") &&
        getComputedStyle(element).visibility === "visible" &&
        element.getClientRects().length > 0;
      const current = document.activeElement as HTMLElement | null;
      // Navigation may already have moved focus to a new view. Keep that target;
      // otherwise avoid returning keyboard users to a hidden or removed opener.
      if (
        current !== document.body &&
        current !== previous &&
        !dialog?.contains(current) &&
        visible(current)
      )
        return;
      const page = document.getElementById("page-content");
      const target = visible(previous)
        ? previous
        : visible(page)
          ? page
          : document.querySelector<HTMLElement>('[aria-label="Open settings"]');
      target?.focus({ preventScroll: true });
    };
  }, [visible]);
  return (
    <dialog
      ref={ref}
      className={`modal modal-${size}`}
      aria-labelledby={id}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const dialog = ref.current;
        if (!dialog) return;
        const controls = [
          ...dialog.querySelectorAll<HTMLElement>(
            "button, input, textarea, select, a[href], [tabindex]",
          ),
        ].filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.matches(":disabled") &&
            element.getClientRects().length > 0,
        );
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first) {
          event.preventDefault();
          dialog.focus();
          return;
        }
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === dialog)
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || document.activeElement === dialog)
        ) {
          event.preventDefault();
          first.focus();
        }
      }}
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
