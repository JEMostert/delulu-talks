import { useEffect, useId, useRef, useState } from "react";
import { Modal } from "./ui";

export type PaletteCommand = {
  id: string;
  label: string;
  detail?: string;
  keywords?: string;
  disabled?: string;
  preview?: Array<{ label: string; before: string; after: string }>;
  confirmationLabel?: string;
  run: () => void | boolean | Promise<void | boolean>;
};

export function CommandPalette({ commands, onClose, actionError }: {
  commands: PaletteCommand[];
  onClose: () => void;
  actionError?: string | null;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorFromAction, setErrorFromAction] = useState(false);
  const [confirmation, setConfirmation] = useState<PaletteCommand | null>(null);
  const running = useRef(false);
  const selectedOption = useRef<HTMLButtonElement | null>(null);
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const visible = commands.filter((command) => {
    const text = `${command.label} ${command.detail ?? ""} ${command.keywords ?? ""}`.toLowerCase();
    return tokens.every((token) => text.includes(token));
  });
  const active = Math.min(index, Math.max(0, visible.length - 1));
  useEffect(() => {
    selectedOption.current?.scrollIntoView({ block: "nearest" });
  }, [active, query]);
  async function execute(command: PaletteCommand | undefined, confirmed = false) {
    if (!command || command.disabled || running.current) return;
    if (command.preview && !confirmed) { setConfirmation(command); setError(""); return; }
    running.current = true;
    setBusy(true);
    setError("");
    setErrorFromAction(false);
    try {
      if (await command.run() === false) { setErrorFromAction(true); setError("The command could not complete. Review the error and try again."); }
      else onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return <Modal title={confirmation?.label ?? "Commands"} busy={busy} onClose={onClose} footer={confirmation ? <>
    <button className="secondary-button" disabled={busy} onClick={() => { setConfirmation(null); setError(""); }}>Back to commands</button>
    <button className="primary-button" disabled={busy} autoFocus onClick={() => void execute(confirmation, true)}>{busy ? "Switching…" : confirmation.confirmationLabel ?? "Confirm"}</button>
  </> : undefined}>
    {confirmation ? <>
      <p>Review the settings before switching. Capture must be idle. Changes made after this preview will cause the switch to be rejected.</p>
      <div className="grid gap-3.5">
        {confirmation.preview?.map((row) => <section key={row.label} className="border border-line rounded-xl p-3.5">
          <h3 className="text-[13px]">{row.label}</h3>
          <div className="grid grid-cols-2 gap-3.5 max-[700px]:grid-cols-1 text-[12px] mt-2">
            <div><span className="text-muted">Current</span><p className="break-words whitespace-pre-wrap">{row.before}</p></div>
            <div><span className="text-muted">After switching</span><p className="break-words whitespace-pre-wrap">{row.after}</p></div>
          </div>
        </section>)}
      </div>
    </> : <>
    <label className="field">Find a command
      <input autoFocus role="combobox" aria-label="Find a command" aria-expanded="true" aria-controls={`${id}-list`} aria-activedescendant={visible.length ? `${id}-${visible[active].id}` : undefined} value={query} disabled={busy} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setIndex(visible.length ? (active + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length : 0);
        }
        if (event.key === "Enter") { event.preventDefault(); void execute(visible[active]); }
      }} />
    </label>
    <div role="listbox" id={`${id}-list`} aria-label="Available commands" className="max-h-[420px] overflow-auto" onKeyDown={(event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const next = visible.length ? (active + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length : 0;
      setIndex(next);
      if (visible[next]) document.getElementById(`${id}-${visible[next].id}`)?.focus();
    }}>
      {visible.map((command, position) => <button key={command.id} id={`${id}-${command.id}`} ref={position === active ? selectedOption : undefined} tabIndex={position === active ? 0 : -1} role="option" aria-selected={active === position} aria-disabled={!!command.disabled || busy} className={`w-full text-left rounded-xl border p-3 mb-2 ${active === position ? "border-accent bg-accent-soft" : "border-line bg-surface"}`} disabled={busy} onMouseEnter={() => setIndex(position)} onFocus={() => setIndex(position)} onClick={() => void execute(command)}>
        <span className="block text-[13px] font-semibold">{command.label}</span>
        {(command.disabled || command.detail) && <span className="block text-[11px] text-muted mt-1">{command.disabled ?? command.detail}</span>}
      </button>)}
      {!visible.length && <p className="text-muted">No matching commands.</p>}
    </div>
    <p className="caption">↑ ↓ choose · Enter run · Escape close</p>
    </>}
    {error && <p className="field-error" role="alert">{errorFromAction && actionError ? actionError : error}</p>}
  </Modal>;
}
