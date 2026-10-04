import type { CaptureDiagnostics as Diagnostics } from "../types";
import { normalizeCaptureDiagnostics } from "../captureDiagnostics";

export function CaptureDiagnostics({ value }: { value?: Diagnostics | null }) {
  const stats = normalizeCaptureDiagnostics(value);
  if (!stats) return null;
  const fraction = stats.clippedSampleCount / stats.sampleCount;
  const peakDb =
    stats.peakAmplitude > 0
      ? `${(20 * Math.log10(stats.peakAmplitude)).toFixed(1)} dBFS`
      : "−∞ dBFS";
  const advice =
    stats.clippedSampleCount > 0
      ? "Possible clipping: lower the microphone input gain in your system settings."
      : stats.peakAmplitude === 0
        ? "No signal measured. Check the selected input and its connection."
        : stats.peakAmplitude < 0.03
          ? "Low level: move closer or raise the input gain in your system settings."
          : "Healthy level with headroom.";
  return (
    <section className="fact-block" aria-label="Input level">
      <h4>Input level</h4>
      <dl className="fact-grid">
        <dt>Peak</dt>
        <dd className="tabular-nums">{peakDb}</dd>
        <dt>Near full scale</dt>
        <dd className="tabular-nums">
          {(fraction * 100).toFixed(2)}% ·{" "}
          {stats.clippedSampleCount.toLocaleString()} of{" "}
          {stats.sampleCount.toLocaleString()} samples
        </dd>
      </dl>
      <p className="caption">
        {advice} Measured before resampling at{" "}
        {stats.sampleRate.toLocaleString()} Hz; the app applies no gain.
      </p>
    </section>
  );
}
