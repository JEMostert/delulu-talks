import { AudioLines, LoaderCircle, Mic } from "lucide-react";
import type { DictationStatus } from "../types";

export function Overlay({ status }: { status: DictationStatus }) {
  const listening = status.phase === "listening";
  const working = ["transcribing", "preparing", "loading"].includes(status.phase);
  return (
    <main className="overlay-root">
      <div className={`overlay-console phase-${status.phase}`}>
        <span className="overlay-icon">{listening ? <Mic /> : working ? <LoaderCircle className="spin" /> : <AudioLines />}</span>
        <div><small>DELULU / {status.phase.toUpperCase()}</small><strong>{listening ? "Listening" : working ? status.message : status.message || "Ready"}</strong></div>
        <div className={listening ? "mini-wave" : "mini-wave paused"}>{Array.from({ length: 8 }).map((_, index) => <i key={index} />)}</div>
      </div>
    </main>
  );
}
