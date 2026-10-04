import { normalizeTimings, TIMING_LABELS } from "../pipelineTimings";
import type { PipelineTimings } from "../types";

export function PipelineTimingDetails({
  timings,
}: {
  timings?: PipelineTimings;
}) {
  const measured = normalizeTimings(timings);
  if (!measured) return null;
  return (
    <section className="fact-block" aria-label="Local processing timings">
      <h4>Processing timings</h4>
      <dl className="fact-grid">
        {(Object.keys(TIMING_LABELS) as (keyof PipelineTimings)[]).map((key) =>
          measured[key] === undefined ? null : (
            <div key={key} className="contents">
              <dt>{TIMING_LABELS[key]}</dt>
              <dd className="tabular-nums">
                {measured[key]!.toLocaleString(undefined, {
                  maximumFractionDigits: 0,
                })}{" "}
                ms
              </dd>
            </div>
          ),
        )}
      </dl>
      <p className="caption">
        Stages can overlap, so they do not add up to total latency. Paste
        dispatch does not confirm insertion in another app.
      </p>
    </section>
  );
}
