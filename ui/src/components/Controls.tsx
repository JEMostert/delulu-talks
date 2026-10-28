import type { ReactNode } from "react";
import { hotkeyKeys } from "../helpers";
import { Icon, type IconName } from "./Icon";

/** One preference row: label and help on the left, the control on the right. */
export function Row({
  label,
  htmlFor,
  help,
  stack,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  help?: ReactNode;
  /** Put the control under the label, for wide controls. */
  stack?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={stack ? "row row-stack" : "row"}>
      <div className="row-text">
        {htmlFor ? (
          <label className="row-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="row-label">{label}</span>
        )}
        {help && <div className="row-help">{help}</div>}
      </div>
      <div className="row-control">{children}</div>
    </div>
  );
}

export function Switch({
  id,
  checked,
  onChange,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: string;
}) {
  return (
    <input
      id={id}
      className="switch"
      type="checkbox"
      role="switch"
      aria-label={label}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

export function Segmented<T extends string>({
  name,
  label,
  value,
  options,
  onChange,
}: {
  name: string;
  label: string;
  value: T;
  options: { value: T; label: string; icon?: IconName }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label
          key={option.value}
          className={option.value === value ? "on" : ""}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            onChange={() => onChange(option.value)}
          />
          {option.icon && <Icon name={option.icon} size={16} />}
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

/** A native select dressed to match; keeps keyboard and screen reader behaviour. */
export function Select({
  id,
  value,
  onChange,
  disabled,
  children,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <span className="select">
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </span>
  );
}

/** The hotkey as keycaps, or a quiet note when the desktop has none bound. */
export function Keys({
  trigger,
  large,
}: {
  trigger: string | null | undefined;
  large?: boolean;
}) {
  const keys = hotkeyKeys(trigger);
  if (!keys.length) return <span className="keys-none">No hotkey yet</span>;
  return (
    <span className={`keys ${large ? "keys-large" : ""}`}>
      {keys.map((key, i) => (
        <kbd key={`${key}-${i}`}>{key}</kbd>
      ))}
    </span>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  tone,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  tone?: "danger";
}) {
  return (
    <button
      type="button"
      className={`icon-button ${tone ?? ""}`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon name={icon} size={17} />
    </button>
  );
}
