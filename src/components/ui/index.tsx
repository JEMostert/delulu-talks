import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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

/**
 * A number input that edits a local draft and saves once, on blur or Enter,
 * so typing "12" never saves "1" and a save in flight never locks the field.
 */
export function NumberField({
  value,
  min,
  max,
  step = 1,
  label,
  disabled,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(String(value));
  }, [value]);
  const commit = () => {
    editing.current = false;
    const parsed = Number(draft);
    if (!draft.trim() || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.min(max, Math.max(min, parsed));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <input
      type="number"
      className="w-24"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={draft}
      disabled={disabled}
      onFocus={() => {
        editing.current = true;
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") {
          editing.current = false;
          setDraft(String(value));
        }
      }}
    />
  );
}

/** A slider that previews locally and saves when the drag or key press ends. */
export function RangeField({
  value,
  min,
  max,
  step,
  label,
  format,
  disabled,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  format: (value: number) => string;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setDraft(value);
  }, [value]);
  const commit = () => {
    dragging.current = false;
    if (draft !== value) onCommit(draft);
  };
  return (
    <div className="inline-control">
      <input
        type="range"
        aria-label={label}
        aria-valuetext={format(draft)}
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        onPointerDown={() => {
          dragging.current = true;
        }}
        onChange={(event) => {
          dragging.current = true;
          setDraft(Number(event.target.value));
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={() => dragging.current && commit()}
      />
      <span className="w-10 text-right tabular-nums text-muted">
        {format(draft)}
      </span>
    </div>
  );
}
