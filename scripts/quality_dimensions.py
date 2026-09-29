"""Compare supplied hypotheses across disclosed, separately scored quality dimensions."""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import re
import unicodedata

from evaluation_report import build_report, require_text
from transcript_metrics import RECIPES, edit_counts

NUMBER_FORMS = re.compile(r"(?<!\w)[+-]?\d+(?:[.,]\d+)*(?:%)?(?!\w)")


def mentions(text: str, entity: str) -> int:
    return len(list(re.finditer(r"(?<!\w)" + re.escape(entity) + r"(?!\w)", text)))


def dimensions(reference: str, hypothesis: str, annotations: dict, max_cells: int) -> dict:
    speech_present = annotations.get("speech_present")
    if not isinstance(speech_present, bool):
        raise ValueError("Every case needs an explicit speech_present annotation")
    if not speech_present and reference.strip():
        raise ValueError("A silence case must have an empty/whitespace reference")
    entities = annotations.get("named_entities")
    if not isinstance(entities, list) or len(entities) != len(set(require_text(entity, "named entity") for entity in entities)):
        raise ValueError("named_entities must be a list of unique explicit entity strings")
    scored_entities = []
    for entity in entities:
        expected = mentions(reference, entity)
        if not expected:
            raise ValueError("Annotated named entities must occur exactly in the reference")
        observed = mentions(hypothesis, entity)
        scored_entities.append({"entity": entity, "expected_mentions": expected, "observed_exact_mentions": observed,
                                "missing_mentions": max(0, expected - observed), "extra_mentions": max(0, observed - expected)})
    expected_numbers = Counter(NUMBER_FORMS.findall(reference))
    observed_numbers = Counter(NUMBER_FORMS.findall(hypothesis))
    expected_punctuation = [char for char in reference if unicodedata.category(char).startswith("P")]
    observed_punctuation = [char for char in hypothesis if unicodedata.category(char).startswith("P")]
    return {
        "punctuation": {"reference_sequence": "".join(expected_punctuation), "hypothesis_sequence": "".join(observed_punctuation),
                        "sequence_alignment": edit_counts(expected_punctuation, observed_punctuation, max_cells),
                        "limitation": "Character sequence comparison; syntactic punctuation correctness is not inferred"},
        "named_entities": {"annotations": scored_entities, "annotation_count": len(entities),
                           "scoring": "Exact case-sensitive Unicode text with word boundaries; no automatic entity detector",
                           "unannotated_entities_scored": False},
        "numbers": {"reference_forms": dict(expected_numbers), "hypothesis_forms": dict(observed_numbers),
                    "missing_forms": dict(expected_numbers - observed_numbers), "extra_forms": dict(observed_numbers - expected_numbers),
                    "scoring": "Exact digit-containing lexical forms; comma/point spelling stays distinct; spoken-number semantics not inferred"},
        "hallucination": {"silence_annotated": not speech_present,
                          "silence_output_nonempty": bool(hypothesis.strip()) if not speech_present else None,
                          "scope": "Nonempty output on explicitly annotated silence only; semantic hallucinations require human review"},
    }


def compare(manifest: dict, directory: Path, max_cells: int) -> dict:
    cases = manifest.get("cases")
    participants = manifest.get("participants")
    if not isinstance(cases, list) or not cases or not isinstance(participants, list) or len(participants) < 2:
        raise ValueError("Need reference cases and at least two participants")
    references = {}
    for case in cases:
        case_id = require_text(case.get("case_id"), "case_id")
        if case_id in references:
            raise ValueError("Reference case IDs must be unique")
        content = (directory / require_text(case.get("reference"), "reference path")).read_bytes()
        if not isinstance(case.get("annotations"), dict):
            raise ValueError("Every case needs an annotations object")
        references[case_id] = (content, case["annotations"])
    recipe = manifest.get("normalization", "wer-basic-v1")
    if recipe not in RECIPES:
        raise ValueError("Unknown normalization recipe")
    outputs, labels = [], set()
    for participant in participants:
        label = require_text(participant.get("label"), "participant.label")
        if label in labels:
            raise ValueError("Participant labels must be unique")
        labels.add(label)
        provenance = json.loads((directory / require_text(participant.get("provenance"), "provenance path")).read_bytes())
        hypotheses = participant.get("hypotheses")
        if not isinstance(hypotheses, dict) or set(hypotheses) != set(references):
            raise ValueError("Each participant must provide exactly the reference case IDs")
        results = []
        for case_id, (reference_bytes, annotations) in references.items():
            supplied = hypotheses[case_id]
            if not isinstance(supplied, dict):
                raise ValueError("Each hypothesis must be an object")
            hypothesis_bytes = (directory / require_text(supplied.get("path"), "hypothesis path")).read_bytes()
            report = build_report(reference_bytes, hypothesis_bytes, provenance, case_id, recipe, max_cells)
            report["quality_dimensions"] = dimensions(reference_bytes.decode("utf-8"), hypothesis_bytes.decode("utf-8"), annotations, max_cells)
            seconds = supplied.get("measured_correction_seconds")
            if seconds is not None and (isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or seconds < 0):
                raise ValueError("measured_correction_seconds must be finite and nonnegative, or omitted")
            report["correction_burden"] = {
                "raw_character_edit_distance_proxy": report["metrics"]["raw"]["character_alignment"]["distance"],
                "measured_correction_seconds_supplied": seconds,
                "measurement_method_supplied": require_text(supplied.get("correction_measurement_method"), "correction_measurement_method") if seconds is not None else None,
                "limitation": "Edit distance is not human effort/time; supplied timing is not independently verified",
            }
            results.append(report)
        outputs.append({"label": label, "cases": results})
    return {"schema": "delulu-quality-dimensions-v1", "participants": outputs,
            "native_inference_run": False, "scope": "Offline supplied-text comparison; no inference or automatic quality approval",
            "evaluator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-cells", type=int, default=4_000_000)
    args = parser.parse_args()
    if args.max_cells <= 0:
        parser.error("--max-cells must be positive")
    try:
        contents = args.manifest.read_bytes()
        manifest = json.loads(contents)
        if not isinstance(manifest, dict):
            raise ValueError("Manifest must be an object")
        report = compare(manifest, args.manifest.parent, args.max_cells)
        report["manifest_sha256"] = hashlib.sha256(contents).hexdigest()
        output = json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
        with args.output.open("x", encoding="utf-8", newline="\n") as target:
            target.write(output)
    except (OSError, UnicodeError, ValueError, KeyError, TypeError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
