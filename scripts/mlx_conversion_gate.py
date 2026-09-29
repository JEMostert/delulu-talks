"""Provisional BF16/quantized MLX gates over supplied evidence; never enables a tier."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import statistics

from evaluation_comparison import build_comparison
from evaluation_report import require_text


def number(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number")
    return float(value)


def memory_evidence(paths: object, directory: Path, repetitions: int) -> dict:
    if not isinstance(paths, list) or len(paths) < repetitions:
        raise ValueError("Memory evidence requires the configured number of independent sessions")
    peaks, hashes, configurations = [], [], []
    for supplied in paths:
        content = (directory / require_text(supplied, "memory summary path")).read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        if digest in hashes:
            raise ValueError("Repeated memory evidence must use distinct session summaries")
        hashes.append(digest)
        summary = json.loads(content)
        if summary.get("schema") != "delulu-process-memory-samples-v1":
            raise ValueError("Memory evidence must be process-memory sampler summaries")
        if summary.get("termination") != "duration-complete" or summary.get("sample_count", 0) < 2 or summary.get("steady_sample_count", 0) < 2:
            raise ValueError("Memory sessions must finish and include peak and steady-window samples")
        peak = number(summary.get("sampled_peak_tree_rss_bytes"), "sampled peak")
        if peak <= 0:
            raise ValueError("Memory evidence needs positive sampled peaks")
        peaks.append(peak)
        provenance = summary["provenance"]
        configurations.append({
            "hardware": provenance["hardware"], "runtime": provenance["runtime"],
            "decode_settings": provenance["decode"]["settings"],
            "language": provenance["decode"]["language"],
            "rewrite_loaded_declared": summary["rewrite_loaded_declared"],
            "sample_interval_seconds": summary["sample_interval_seconds"],
            "duration_requested_seconds": summary["duration_requested_seconds"],
            "steady_window_start_seconds": summary["steady_window_start_seconds"],
        })
    if any(config != configurations[0] for config in configurations):
        raise ValueError("Repeated memory sessions must have matching declared configurations")
    return {"session_count": len(peaks), "median_sampled_peak_rss_bytes": statistics.median(peaks),
            "session_peak_rss_bytes": peaks, "summary_sha256": hashes, "configuration": configurations[0]}


def gate(manifest: dict, directory: Path) -> dict:
    comparison = build_comparison(manifest["comparison"], directory)
    participants = comparison["participants"]
    if len(participants) != 2:
        raise ValueError("Gate needs exactly one BF16 baseline and one quantized candidate")
    baseline_label = require_text(manifest.get("baseline"), "baseline")
    candidate_label = require_text(manifest.get("candidate"), "candidate")
    by_label = {participant["label"]: participant for participant in participants}
    if baseline_label == candidate_label or set(by_label) != {baseline_label, candidate_label}:
        raise ValueError("Baseline and candidate must name distinct comparison participants")
    baseline, candidate = by_label[baseline_label], by_label[candidate_label]
    if baseline["role"] != "supported-r2t2-adapter" or candidate["role"] != "external-benchmark-control":
        raise ValueError("BF16 is the supported baseline; experimental quantization remains an external control")
    if manifest.get("candidate_source_repository") != "netease-youdao/Confucius4-R2T2":
        raise ValueError("Declare the experimental conversion's R2T2 source repository")
    maximum_increase = number(manifest.get("max_case_wer_increase"), "max_case_wer_increase")
    minimum_saving = number(manifest.get("min_sampled_peak_memory_saving_fraction"), "minimum memory saving")
    repetitions = manifest.get("minimum_memory_sessions")
    if not 0 <= maximum_increase <= 1 or not 0 < minimum_saving < 1:
        raise ValueError("WER increase must be within [0,1]; memory saving fraction within (0,1)")
    if isinstance(repetitions, bool) or not isinstance(repetitions, int) or repetitions < 2:
        raise ValueError("minimum_memory_sessions must be an integer of at least two")
    case_results = []
    for before, after in zip(baseline["cases"], candidate["cases"]):
        before_provenance, after_provenance = before["provenance"], after["provenance"]
        if before_provenance["model"]["repository"] != "mlx-community/Confucius4-R2T2-bf16" or before_provenance["decode"]["precision"].lower() not in {"bf16", "bfloat16"}:
            raise ValueError("Baseline must be the BF16 R2T2 MLX conversion")
        if after_provenance["decode"]["precision"].lower() not in {"int4", "int8", "4bit", "8bit", "q4", "q8"}:
            raise ValueError("Candidate must explicitly identify 4-bit or 8-bit quantization")
        for section in ("hardware", "runtime"):
            if before_provenance[section] != after_provenance[section]:
                raise ValueError(f"Baseline/candidate {section} must match")
        if before_provenance["decode"]["settings"] != after_provenance["decode"]["settings"] or before_provenance["decode"]["language"] != after_provenance["decode"]["language"]:
            raise ValueError("Decode settings and language must match except precision")
        before_wer, after_wer = before["word_error_rate"], after["word_error_rate"]
        increase = None if before_wer is None or after_wer is None else number(after_wer, "candidate WER") - number(before_wer, "baseline WER")
        case_results.append({"case_id": before["case_id"], "wer_increase": increase,
                             "wer_passed": increase is not None and increase <= maximum_increase,
                             "baseline_exact_fidelity_retained": not before["raw_exact_match"] or after["raw_exact_match"]})
    before_memory = memory_evidence(manifest.get("baseline_memory"), directory, repetitions)
    after_memory = memory_evidence(manifest.get("candidate_memory"), directory, repetitions)
    if before_memory["configuration"] != after_memory["configuration"]:
        raise ValueError("Baseline/candidate memory sessions must have matching declared configurations")
    if before_memory["configuration"]["hardware"] != baseline["cases"][0]["provenance"]["hardware"]:
        raise ValueError("Memory and accuracy evidence must use matching declared hardware")
    saving = 1 - after_memory["median_sampled_peak_rss_bytes"] / before_memory["median_sampled_peak_rss_bytes"]
    quality_passed = all(case["wer_passed"] and case["baseline_exact_fidelity_retained"] for case in case_results)
    return {
        "schema": "delulu-mlx-conversion-gate-v1", "comparison": comparison,
        "quality_cases": case_results, "quality_gate_passed": quality_passed,
        "baseline_memory": before_memory, "candidate_memory": after_memory,
        "sampled_peak_memory_saving_fraction": saving,
        "memory_gate_passed": saving >= minimum_saving,
        "supplied_evidence_gate_passed": quality_passed and saving >= minimum_saving,
        "thresholds": {"max_case_wer_increase": maximum_increase, "min_sampled_peak_memory_saving_fraction": minimum_saving, "minimum_memory_sessions": repetitions},
        "candidate_source_repository_declared": manifest["candidate_source_repository"],
        "native_evidence_independently_verified": False, "low_memory_tier_enabled": False,
        "decision": "Provisional supplied-evidence gate only; native compatibility and source provenance still require verification before offering a tier",
        "limitations": ["RSS savings do not establish accelerator-memory savings", "Session independence and metadata are operator declarations", "Conversion source and weights are not verified by this evaluator"],
        "gate_evaluator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
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
        report = gate(manifest, args.manifest.parent)
        report["manifest_sha256"] = hashlib.sha256(contents).hexdigest()
        output = json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
        with args.output.open("x", encoding="utf-8", newline="\n") as target:
            target.write(output)
    except (OSError, UnicodeError, ValueError, KeyError, TypeError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
