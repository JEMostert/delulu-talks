import { normalizeTimings, TIMING_LABELS } from "../pipelineTimings";
import type { PipelineTimings } from "../types";

export function PipelineTimingDetails({ timings }: { timings?: PipelineTimings }) {
  const measured = normalizeTimings(timings);
  if (!measured) return null;
  return (
    <details className="mt-3 text-xs text-muted">
      <summary className="cursor-pointer">Local processing timings</summary>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        {(Object.keys(TIMING_LABELS) as (keyof PipelineTimings)[]).map((key) =>
          measured[key] === undefined ? null : (
            <div key={key} className="contents">
              <dt>{TIMING_LABELS[key]}</dt>
              <dd>{measured[key]!.toLocaleString(undefined, { maximumFractionDigits: 2 })} ms</dd>
            </div>
          ),
        )}
      </dl>
      <p className="mt-2">Measured stages can overlap; do not add them to estimate total latency. Missing stages were not measured. Paste dispatch does not confirm insertion in another application.</p>
    </details>
  );
}
