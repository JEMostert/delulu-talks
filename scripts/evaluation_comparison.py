"""Record matched evaluation comparisons without adding app speech options."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from evaluation_report import require_text, validate_provenance

R2T2_REPOSITORIES = {
    "netease-youdao/Confucius4-R2T2",
    "mlx-community/Confucius4-R2T2-bf16",
}


def build_comparison(manifest: dict, directory: Path) -> dict:
    participants = manifest.get("participants")
    if not isinstance(participants, list) or len(participants) < 2:
        raise ValueError("At least two participants are required")
    results = []
    labels = set()
    canonical_cases = None
    for participant in participants:
        if not isinstance(participant, dict):
            raise ValueError("Each participant must be an object")
        label = require_text(participant.get("label"), "participant.label")
        if label in labels:
            raise ValueError("Participant labels must be unique")
        labels.add(label)
        role = participant.get("role")
        if role not in {"supported-r2t2-adapter", "external-benchmark-control"}:
            raise ValueError("Role must be supported-r2t2-adapter or external-benchmark-control")
        paths = participant.get("reports")
        if not isinstance(paths, list) or not paths:
            raise ValueError("Each participant needs at least one report")
        cases = {}
        summaries = []
        for supplied_path in paths:
            path = directory / require_text(supplied_path, "report path")
            contents = path.read_bytes()
            report = json.loads(contents)
            if report.get("schema") != "delulu-evaluation-report-v1":
                raise ValueError(f"Unsupported report schema: {path}")
            provenance = validate_provenance(report.get("provenance"))
            if role == "supported-r2t2-adapter" and provenance["model"]["repository"] not in R2T2_REPOSITORIES:
                raise ValueError("Only the app's R2T2 checkpoints can be classified as supported adapters")
            case = require_text(report.get("case_id"), "report.case_id")
            if case in cases:
                raise ValueError("One report per case/participant is required; repeated runs belong in a benchmark artifact")
            metrics = report["metrics"]
            # Same reference bytes and normalization are essential for fair WER
            # comparisons; differences must be separate comparison records.
            cases[case] = (report["inputs"]["reference_sha256"], metrics["normalized"]["recipe"],
                           metrics["normalized"]["operations"], metrics["unicode_version"])
            summaries.append({
                "case_id": case,
                "report_sha256": hashlib.sha256(contents).hexdigest(),
                "provenance": provenance,
                "raw_exact_match": metrics["raw"]["exact_match"],
                "character_error_rate": metrics["raw"]["character_error_rate"],
                "word_error_rate": metrics["normalized"]["word_error_rate"],
                "word_alignment": metrics["normalized"]["word_alignment"],
                "reference_words": metrics["normalized"]["reference_words"],
            })
        if canonical_cases is None:
            canonical_cases = cases
        elif cases != canonical_cases:
            raise ValueError("Participants must cover identical case IDs, reference hashes and normalization settings")
        results.append({"label": label, "role": role, "cases": sorted(summaries, key=lambda case: case["case_id"])})
    return {
        "schema": "delulu-evaluation-comparison-v1",
        "title": require_text(manifest.get("title"), "title"),
        "tradeoffs": require_text(manifest.get("tradeoffs"), "tradeoffs"),
        "limitations": require_text(manifest.get("limitations"), "limitations"),
        "participants": results,
        "scope": "Supplied transcript comparisons; external controls are not app speech options",
        "native_inference_run": False,
        "automatic_winner_selected": False,
        "comparison_evaluator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
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
        report = build_comparison(manifest, args.manifest.parent)
        report["manifest_sha256"] = hashlib.sha256(contents).hexdigest()
        output = json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
        with args.output.open("x", encoding="utf-8", newline="\n") as target:
            target.write(output)
    except (OSError, UnicodeError, ValueError, KeyError, TypeError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
