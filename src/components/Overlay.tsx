import type { DictationStatus } from "../types";
import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { bridge } from "../bridge";

const WAVE_PROFILE = [.14, .22, .34, .48, .66, .82, .94, 1, 1, .94, .82, .66, .48, .34, .22, .14];

export function Overlay({ status }: { status: DictationStatus }) {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    document.documentElement.classList.add("overlay-document");
    return () => document.documentElement.classList.remove("overlay-document");
  }, []);

  useEffect(() => {
    const listener = bridge.onAudioLevel(({ level: nextLevel }) => setLevel(nextLevel));
    return () => { void listener.then((unlisten) => unlisten()); };
  }, []);

  useEffect(() => {
    if (status.phase !== "listening") setLevel(0);
  }, [status.phase]);

  if (status.phase !== "listening") return null;

  return (
    <main className="overlay-root" aria-label="Recording in progress">
      <div className="voice-wave" role="meter" aria-label="Live microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
        {WAVE_PROFILE.map((profile, index) => (
          <i key={index} style={{ "--wave-height": `${2 + level * (6 + profile * 38)}px` } as CSSProperties} />
        ))}
      </div>
    </main>
  );
}
