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
  return (
    <details className="mx-3.5 my-2 text-[11px] text-muted">
      <summary className="cursor-pointer">
        Input level · peak {peakDb} · near-full-scale{" "}
        {(fraction * 100).toFixed(2)}%
      </summary>
      <p className="mt-1 leading-relaxed">
        {stats.clippedSampleCount > 0
          ? "Possible clipping: try lowering the microphone input gain in system or device settings."
          : stats.peakAmplitude === 0
            ? "No signal measured. Check the selected input, microphone connection and device controls."
            : stats.peakAmplitude < 0.03
              ? "Low recorded level: try moving closer or raising input gain in system or device settings."
              : "Recorded input has headroom. No gain adjustment is applied by the app."}{" "}
        Peak amplitude {stats.peakAmplitude.toFixed(4)};{" "}
        {stats.clippedSampleCount.toLocaleString()} of{" "}
        {stats.sampleCount.toLocaleString()} samples at or above{" "}
        {stats.clippingThreshold} ({stats.sampleRate.toLocaleString()} Hz).{" "}
        Measured before resampling. This does not measure hardware gain or prove
        hardware clipping. Raw audio is unchanged by these diagnostics.
      </p>
    </details>
  );
}
