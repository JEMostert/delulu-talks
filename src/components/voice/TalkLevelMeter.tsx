import { useEffect, useRef } from "react";
import { bridge } from "../../bridge";
import { dbToLevel, meterStep } from "../../talk";

// Levels arrive up to ~15 times a second; a longer gap means the mic closed.
const STALE_MS = 400;

/** Live microphone level while Talk is on; animates outside React state. */
export function TalkLevelMeter() {
  const fill = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let target = 0;
    let shown = 0;
    let heard = 0;
    let last = 0;
    let frame = 0;
    const draw = (now: number) => {
      if (now - heard > STALE_MS) target = 0;
      shown = meterStep(shown, target, now - last);
      last = now;
      fill.current?.style.setProperty("--talk-level", shown.toFixed(3));
      frame = shown > 0 || target > 0 ? requestAnimationFrame(draw) : 0;
    };
    const remove = bridge.onTalkLevel((level) => {
      target = dbToLevel(level?.db);
      heard = performance.now();
      if (!frame) {
        last = heard;
        frame = requestAnimationFrame(draw);
      }
    });
    return () => {
      remove();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <span className="talk-meter" title="Microphone level" aria-hidden="true">
      <span ref={fill} />
    </span>
  );
}
