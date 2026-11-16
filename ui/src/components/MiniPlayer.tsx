import type { RadioState } from "../useRadio";
import { IconButton } from "./Controls";

/** Delulu FM in the rail, on every page, while the station is on air. */
export function MiniPlayer({
  radio,
  onOpen,
}: {
  radio: RadioState;
  onOpen: () => void;
}) {
  const r = radio.view?.radio;
  if (!r?.available || !(r.onAir || (r.playing && r.now))) return null;
  const live = r.playing && !r.held;
  const title = r.now?.title ?? "Making a song";
  const subtitle = r.held
    ? "Quiet while you dictate"
    : r.now
      ? r.now.kind === "break"
        ? "Host"
        : r.now.subtitle
      : "Coming up";
  return (
    <section className="mini" aria-label="Delulu FM">
      <button
        type="button"
        className="mini-info"
        data-tip="Open Delulu FM"
        onClick={onOpen}
      >
        <b>{title}</b>
        <small>
          <span
            className={`mini-live ${live ? "on" : ""}`}
            aria-hidden="true"
          />
          <span className="mini-sub">{subtitle}</span>
        </small>
      </button>
      <IconButton
        icon={r.playing ? "pause" : "play"}
        label={r.playing ? "Pause" : "Play"}
        size={16}
        disabled={radio.busy}
        onClick={radio.toggle}
      />
      <IconButton
        icon="skip"
        label="Skip"
        size={16}
        disabled={radio.busy || !r.now}
        onClick={radio.skip}
      />
    </section>
  );
}
