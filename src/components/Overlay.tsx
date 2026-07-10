import { AudioLines, LoaderCircle, Mic } from "lucide-react";
import type { DictationStatus } from "../types";

export function Overlay({ status }: { status: DictationStatus }) {
  const active = status.phase === "listening";
  return (
    <main className="overlay-root">
      <div className={`overlay-capsule phase-${status.phase}`}>
        <span className="overlay-icon">{active ? <Mic /> : status.phase === "transcribing" ? <LoaderCircle className="spin" /> : <AudioLines />}</span>
        <div><strong>{active ? "Listening" : status.phase === "transcribing" ? "Making it readable" : status.phase}</strong><small>{status.message || "Delulu is ready"}</small></div>
        <div className="mini-wave">{Array.from({ length: 8 }).map((_, index) => <i key={index} />)}</div>
      </div>
    </main>
  );
}
