"""Opt-in, read-only RSS sampler for an existing Delulu process tree.

Requires psutil in the observer's Python environment. Does not load or unload
models, launch inference, change settings, or terminate the observed process.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import statistics
import time

from evaluation_report import validate_provenance


def sample(args, psutil) -> None:
    provenance = validate_provenance(json.loads(args.provenance.read_bytes()))
    root = psutil.Process(args.pid)
    identity = root.create_time()
    # Open exclusive outputs before observing. Both live in a new directory,
    # preserving any previous run and retaining partial samples on interruption.
    args.output_directory.mkdir()
    started = time.monotonic()
    steady = []
    all_values = []
    skipped = 0
    reason = "duration-complete"
    error = None
    samples_path = args.output_directory / "samples.jsonl"
    try:
        with samples_path.open("x", encoding="utf-8", newline="\n") as output:
            while time.monotonic() - started < args.duration:
                tick = time.monotonic()
                try:
                    if not root.is_running() or root.create_time() != identity:
                        reason = "observed-process-exited"
                        break
                    children = root.children(recursive=True)
                    processes = [root, *children]
                    entries = []
                    for process in processes:
                        try:
                            info = process.memory_info()
                            entries.append({"pid": process.pid, "created_epoch_seconds": process.create_time(), "rss_bytes": info.rss})
                        except psutil.NoSuchProcess:
                            skipped += 1
                    # Permission failures are fatal: an incomplete accessible
                    # subset must not masquerade as whole-tree memory.
                    elapsed = tick - started
                    total = sum(entry["rss_bytes"] for entry in entries)
                    row = {"elapsed_seconds": elapsed, "process_tree_rss_bytes": total, "processes": entries}
                    output.write(json.dumps(row, allow_nan=False) + "\n")
                    output.flush()
                    all_values.append(total)
                    if elapsed >= args.steady_after:
                        steady.append(total)
                except psutil.NoSuchProcess:
                    reason = "observed-process-exited"
                    break
                remaining = args.interval - (time.monotonic() - tick)
                if remaining > 0:
                    time.sleep(min(remaining, max(0, args.duration - (time.monotonic() - started))))
    except KeyboardInterrupt:
        reason = "interrupted"
    except Exception as failure:
        reason = "sampling-error"
        error = failure
    finally:
        metadata = {
            "schema": "delulu-process-memory-samples-v1",
            "created_utc": datetime.now(timezone.utc).isoformat(),
            "provenance": provenance,
            "root_pid": args.pid, "root_created_epoch_seconds": identity,
            "rewrite_loaded_declared": args.rewrite_loaded == "yes",
            "rewrite_state_verification": "Operator declaration; sampler does not inspect model state",
            "duration_requested_seconds": args.duration,
            "duration_observed_seconds": time.monotonic() - started,
            "sample_interval_seconds": args.interval,
            "steady_window_start_seconds": args.steady_after,
            "sample_count": len(all_values), "steady_sample_count": len(steady),
            "sampled_peak_tree_rss_bytes": max(all_values) if all_values else None,
            "steady_tree_rss_mean_bytes": statistics.mean(steady) if steady else None,
            "steady_tree_rss_median_bytes": statistics.median(steady) if steady else None,
            "steady_tree_rss_min_bytes": min(steady) if steady else None,
            "steady_tree_rss_max_bytes": max(steady) if steady else None,
            "exited_child_reads_skipped": skipped,
            "termination": reason,
            "samples_sha256": hashlib.sha256(samples_path.read_bytes()).hexdigest() if samples_path.exists() else None,
            "sampler_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "psutil_version": psutil.__version__,
            "limitations": [
                "Sampled RSS maximum is a lower bound on instantaneous peak",
                "Summed process RSS may count shared pages more than once",
                "RSS is not accelerator allocation, unified-memory pressure or system-wide consumption",
                "Short-lived descendants may be missed between samples",
                "Steady window is chosen by the operator; equilibrium is not established",
                "No inference, model-state verification or model lifecycle action is performed by the sampler",
            ],
        }
        (args.output_directory / "summary.json").write_text(json.dumps(metadata, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    if error is not None:
        raise error
    if not all_values:
        raise ValueError("No process-memory samples collected; retained summary records termination")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pid", type=int, required=True, help="Existing application or worker process; descendants included")
    parser.add_argument("--provenance", type=Path, required=True)
    parser.add_argument("--rewrite-loaded", choices=("yes", "no"), required=True)
    parser.add_argument("--duration", type=float, default=60)
    parser.add_argument("--interval", type=float, default=0.25)
    parser.add_argument("--steady-after", type=float, default=10)
    parser.add_argument("--output-directory", type=Path, required=True)
    args = parser.parse_args()
    if args.pid <= 0 or not all(math.isfinite(value) for value in (args.duration, args.interval, args.steady_after)):
        parser.error("PID must be positive and timings must be finite")
    if not 0.05 <= args.interval <= args.duration <= 3600 or not 0 <= args.steady_after < args.duration:
        parser.error("Require 0.05 <= interval <= duration <= 3600 and 0 <= steady-after < duration")
    try:
        import psutil
    except ImportError:
        parser.error("Install psutil in the observer environment; the app runtime is not modified")
    try:
        sample(args, psutil)
    except (OSError, UnicodeError, ValueError, psutil.Error) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
