"""Build a provenance-bound report from supplied reference/hypothesis text.

No model execution or hardware detection is performed. Provenance describes
where the supplied hypothesis came from, not where this evaluator runs.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

from transcript_metrics import RECIPES, evaluate_transcripts


def require_text(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a nonempty string (use 'unknown' explicitly when unavailable)")
    return value


def validate_provenance(value: object) -> dict:
    if not isinstance(value, dict):
        raise ValueError("Provenance must be a JSON object")
    fields = {
        "model": ("repository", "revision", "conversion_provenance"),
        "runtime": ("backend", "revision", "dependencies"),
        "hardware": ("os", "processor", "accelerator", "memory"),
        "decode": ("language", "precision", "settings"),
    }
    result = {}
    for section, names in fields.items():
        supplied = value.get(section)
        if not isinstance(supplied, dict):
            raise ValueError(f"provenance.{section} must be an object")
        result[section] = {}
        for name in names:
            entry = supplied.get(name)
            if name in {"dependencies", "settings"}:
                if not isinstance(entry, dict):
                    raise ValueError(f"provenance.{section}.{name} must be an object")
                result[section][name] = entry
            else:
                result[section][name] = require_text(entry, f"provenance.{section}.{name}")
    result["hypothesis_origin"] = require_text(value.get("hypothesis_origin"), "provenance.hypothesis_origin")
    # Keep an explicit distinction between supplied metadata and measured facts.
    result["verification"] = "User-supplied provenance; evaluator does not verify inference or hardware"
    return result


def build_report(reference_bytes: bytes, hypothesis_bytes: bytes, provenance: dict,
                 case_id: str, recipe: str, max_cells: int) -> dict:
    metadata = validate_provenance(provenance)
    metrics = evaluate_transcripts(reference_bytes.decode("utf-8"), hypothesis_bytes.decode("utf-8"), recipe, max_cells)
    return {
        "schema": "delulu-evaluation-report-v1",
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "case_id": require_text(case_id, "case_id"),
        "provenance": metadata,
        "inputs": {
            "reference_sha256": hashlib.sha256(reference_bytes).hexdigest(),
            "hypothesis_sha256": hashlib.sha256(hypothesis_bytes).hexdigest(),
        },
        "evaluators": {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                       for path in (Path(__file__), Path(__file__).with_name("transcript_metrics.py"))},
        "metrics": metrics,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--hypothesis", type=Path, required=True)
    parser.add_argument("--provenance", type=Path, required=True)
    parser.add_argument("--case-id", required=True)
    parser.add_argument("--normalization", choices=RECIPES, default="wer-basic-v1")
    parser.add_argument("--max-cells", type=int, default=4_000_000)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.max_cells <= 0:
        parser.error("--max-cells must be positive")
    try:
        report = build_report(args.reference.read_bytes(), args.hypothesis.read_bytes(),
                              json.loads(args.provenance.read_bytes()), args.case_id,
                              args.normalization, args.max_cells)
        output = json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
        with args.output.open("x", encoding="utf-8", newline="\n") as target:
            target.write(output)
    except (OSError, UnicodeError, ValueError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
