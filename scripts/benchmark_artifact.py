"""Retain supplied benchmark measurements and raw artifacts; never run a benchmark."""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import shutil
import statistics

from evaluation_report import require_text, validate_provenance


def measured_number(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or value < 0:
        raise ValueError(f"{name} must be a finite nonnegative number")
    return float(value)


def summarize_runs(runs: list) -> dict:
    groups = defaultdict(list)
    seen = set()
    for run in runs:
        if not isinstance(run, dict):
            raise ValueError("Each run must be an object")
        run_id = require_text(run.get("run_id"), "run_id")
        if run_id in seen:
            raise ValueError("run_id must be unique")
        seen.add(run_id)
        case = require_text(run.get("case_id"), "case_id")
        phase = run.get("phase")
        if phase not in {"cold", "warm", "load", "warmup"}:
            raise ValueError("phase must be cold, warm, load or warmup")
        values = run.get("measurements")
        if not isinstance(values, dict) or not values:
            raise ValueError("Each run needs measurements with explicit units")
        for metric, measurement in values.items():
            require_text(metric, "metric name")
            if not isinstance(measurement, dict):
                raise ValueError("Measurement must contain value and unit")
            unit = require_text(measurement.get("unit"), "measurement.unit")
            number = measured_number(measurement.get("value"), "measurement.value")
            groups[(case, phase, metric, unit)].append(number)
    output = []
    for (case, phase, metric, unit), values in sorted(groups.items()):
        deviation = statistics.stdev(values) if len(values) > 1 else None
        output.append({
            "case_id": case, "phase": phase, "metric": metric, "unit": unit,
            "repeated_run_count": len(values), "mean": statistics.mean(values),
            "median": statistics.median(values), "minimum": min(values), "maximum": max(values),
            "sample_standard_deviation": deviation,
            "standard_error_if_independent": deviation / math.sqrt(len(values)) if deviation is not None else None,
            "uncertainty_note": "Descriptive spread only; independence is not established; one run has unknown spread",
        })
    return {"run_count": len(runs), "groups": output}


def retain_bundle(manifest_path: Path, destination: Path) -> None:
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    if not isinstance(manifest, dict):
        raise ValueError("Manifest must be an object")
    provenance = validate_provenance(manifest.get("provenance"))
    require_text(manifest.get("measurement_method"), "measurement_method")
    require_text(manifest.get("limitations"), "limitations")
    runs = manifest.get("runs")
    if not isinstance(runs, list) or not runs:
        raise ValueError("At least one measured run is required")
    summary = summarize_runs(runs)
    files = manifest.get("artifacts")
    if not isinstance(files, list) or not files:
        raise ValueError("Raw artifact files are required")
    # Validate all metadata before creating a destination. Sources may be local
    # transcripts/logs and are included only through this explicit manifest.
    sources = []
    for artifact in files:
        if not isinstance(artifact, dict):
            raise ValueError("Each artifact must be an object")
        role = require_text(artifact.get("role"), "artifact.role")
        path = manifest_path.parent / require_text(artifact.get("path"), "artifact.path")
        if not path.is_file():
            raise ValueError(f"Artifact is not a file: {path}")
        sources.append((role, path))
    destination.mkdir()  # Never replace a prior artifact directory.
    try:
        raw = destination / "raw"
        raw.mkdir()
        retained = []
        for index, (role, source) in enumerate(sources, 1):
            # Copy bytes through our own deterministic names; supplied paths
            # cannot escape the new output directory. Hash retained bytes.
            relative = f"raw/artifact-{index:04d}"
            target = destination / relative
            digest = hashlib.sha256()
            size = 0
            with source.open("rb") as origin, target.open("xb") as output:
                while block := origin.read(1024 * 1024):
                    output.write(block)
                    digest.update(block)
                    size += len(block)
            retained.append({"role": role, "file": relative, "sha256": digest.hexdigest(), "bytes": size})
        (destination / "manifest.json").write_bytes(manifest_bytes)
        report = {
            "schema": "delulu-benchmark-artifact-v1",
            "created_utc": datetime.now(timezone.utc).isoformat(),
            "provenance": provenance,
            "measurement_method": manifest["measurement_method"],
            "limitations": manifest["limitations"],
            "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "artifact_builder_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "runs": runs, "summary": summary, "raw_artifacts": retained,
            "scope": "Retained supplied measurements; builder performs no inference or hardware verification",
            "native_inference_run": False,
        }
        (destination / "report.json").write_text(json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")
    except BaseException:
        # The mkdir succeeded, so this directory belongs only to this attempt.
        # Remove incomplete bundles rather than leave a misleading final report.
        shutil.rmtree(destination)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output-directory", type=Path, required=True)
    args = parser.parse_args()
    try:
        retain_bundle(args.manifest, args.output_directory)
    except (OSError, UnicodeError, ValueError, TypeError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
