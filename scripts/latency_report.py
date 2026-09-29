"""Report distinct latency stages from supplied same-clock event traces."""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path
import statistics

from evaluation_report import require_text, validate_provenance

STAGES = {
    "cold-startup": ("cold_start_started", "speech_ready"),
    "first-request": ("request_started", "request_completed"),
    "warm-request": ("request_started", "request_completed"),
    "speech-end-to-delivery": ("speech_ended", "delivery_completed"),
}


def seconds(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError("Event timestamps must be finite nonnegative seconds")
    return float(value)


def build_report(manifest: dict) -> dict:
    provenance = validate_provenance(manifest.get("provenance"))
    method = require_text(manifest.get("measurement_method"), "measurement_method")
    traces = manifest.get("traces")
    if not isinstance(traces, list) or not traces:
        raise ValueError("At least one measured trace is required")
    seen, observations, groups = set(), [], defaultdict(list)
    for trace in traces:
        if not isinstance(trace, dict):
            raise ValueError("Every trace must be an object")
        trace_id = require_text(trace.get("trace_id"), "trace_id")
        if trace_id in seen:
            raise ValueError("trace_id must be unique")
        seen.add(trace_id)
        stage = trace.get("stage")
        if stage not in STAGES:
            raise ValueError("Unknown latency stage")
        clock = require_text(trace.get("clock_id"), "clock_id")
        generation = require_text(trace.get("worker_generation"), "worker_generation")
        if stage in {"first-request", "warm-request"}:
            ordinal = trace.get("request_ordinal")
            if isinstance(ordinal, bool) or not isinstance(ordinal, int) or ordinal < 1:
                raise ValueError("Request stages need a positive request ordinal within the worker generation")
            if (stage == "first-request" and ordinal != 1) or (stage == "warm-request" and ordinal < 2):
                raise ValueError("First requests have ordinal one; warm requests have ordinal two or greater")
        events = trace.get("events")
        if not isinstance(events, dict):
            raise ValueError("Trace events must be an object of same-clock seconds")
        start_event, end_event = STAGES[stage]
        start, end = seconds(events.get(start_event)), seconds(events.get(end_event))
        if end < start:
            raise ValueError("Latency endpoints are reversed; do not combine timestamps from different clocks")
        elapsed = end - start
        groups[stage].append(elapsed)
        observations.append({"trace_id": trace_id, "stage": stage, "clock_id": clock,
                             "worker_generation": generation, "case_id": require_text(trace.get("case_id"), "case_id"),
                             "request_ordinal": trace.get("request_ordinal"), "start_event": start_event,
                             "end_event": end_event, "start_seconds": start, "end_seconds": end, "elapsed_seconds": elapsed})
    summaries = {}
    for stage, endpoints in STAGES.items():
        values = sorted(groups[stage])
        deviation = statistics.stdev(values) if len(values) > 1 else None
        summaries[stage] = {
            "start_event": endpoints[0], "end_event": endpoints[1], "observation_count": len(values),
            "mean_seconds": statistics.mean(values) if values else None,
            "median_seconds": statistics.median(values) if values else None,
            "p95_nearest_rank_seconds": values[math.ceil(0.95 * len(values)) - 1] if values else None,
            "minimum_seconds": min(values) if values else None, "maximum_seconds": max(values) if values else None,
            "sample_standard_deviation_seconds": deviation,
            "status": "supplied-observations" if values else "not-measured",
        }
    return {
        "schema": "delulu-latency-report-v1", "provenance": provenance,
        "measurement_method": method, "observations": observations, "stages": summaries,
        "all_stages_measured": all(groups[stage] for stage in STAGES),
        "native_inference_run": False,
        "limitations": [
            "Same-clock endpoints are supplied declarations; clock provenance is not independently verified",
            "First/warm classification uses declared generation and request ordinal, not model-residency inspection",
            "Delivery completion means the declared endpoint; clipboard/shortcut timing does not prove destination insertion",
            "Stages may overlap and are not summed into a combined performance figure",
            "Percentiles and spread are descriptive supplied observations; no confidence interval is inferred",
        ],
        "evaluator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        contents = args.manifest.read_bytes()
        manifest = json.loads(contents)
        if not isinstance(manifest, dict):
            raise ValueError("Manifest must be an object")
        report = build_report(manifest)
        report["manifest_sha256"] = hashlib.sha256(contents).hexdigest()
        output = json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
        with args.output.open("x", encoding="utf-8", newline="\n") as target:
            target.write(output)
    except (OSError, UnicodeError, ValueError, TypeError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
