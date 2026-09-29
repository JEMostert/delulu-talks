"""Separate raw text fidelity from explicitly normalized ASR word metrics.

Reads supplied UTF-8 reference/hypothesis files. Never invokes a model or edits
inputs; report files are create-only. Normalization is disclosed in the report.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
from typing import Sequence
import unicodedata

RECIPES = {
    "none": [],
    "wer-basic-v1": [
        "Unicode NFC",
        "Unicode casefold",
        "remove Unicode punctuation categories P*",
        "collapse whitespace to single spaces",
    ],
}


def normalize_text(text: str, recipe: str) -> str:
    if recipe == "none":
        return text
    if recipe != "wer-basic-v1":
        raise ValueError("Unknown normalization recipe")
    text = unicodedata.normalize("NFC", text).casefold()
    text = "".join(char for char in text if not unicodedata.category(char).startswith("P"))
    return " ".join(text.split())


def edit_counts(reference: Sequence[str], hypothesis: Sequence[str], max_cells: int) -> dict:
    """Unit-cost alignment; ties prefer substitution, deletion, then insertion."""
    if reference == hypothesis:
        return {"distance": 0, "substitutions": 0, "deletions": 0, "insertions": 0}
    if (len(reference) + 1) * (len(hypothesis) + 1) > max_cells:
        raise ValueError("Alignment exceeds --max-cells; split the case or explicitly raise the limit")
    # Each cell retains (cost, substitutions, deletions, insertions). Only two
    # rows are needed; alignment content is never added to the report.
    previous = [(j, 0, 0, j) for j in range(len(hypothesis) + 1)]
    for i, expected in enumerate(reference, 1):
        current = [(i, 0, i, 0)]
        for j, observed in enumerate(hypothesis, 1):
            if expected == observed:
                current.append(previous[j - 1])
                continue
            cost, substitutions, deletions, insertions = previous[j - 1]
            substitute = (cost + 1, substitutions + 1, deletions, insertions)
            cost, substitutions, deletions, insertions = previous[j]
            delete = (cost + 1, substitutions, deletions + 1, insertions)
            cost, substitutions, deletions, insertions = current[j - 1]
            insert = (cost + 1, substitutions, deletions, insertions + 1)
            current.append(min((substitute, delete, insert), key=lambda cell: cell[0]))
        previous = current
    cost, substitutions, deletions, insertions = previous[-1]
    return {"distance": cost, "substitutions": substitutions, "deletions": deletions, "insertions": insertions}


def text_shape(text: str) -> dict:
    punctuation = Counter(char for char in text if unicodedata.category(char).startswith("P"))
    return {
        "characters": len(text),
        "punctuation_counts": dict(sorted(punctuation.items())),
        "line_feeds": text.count("\n"),
        "carriage_returns": text.count("\r"),
        "tabs": text.count("\t"),
        "leading_whitespace_characters": len(text) - len(text.lstrip()),
        "trailing_whitespace_characters": len(text) - len(text.rstrip()),
    }


def error_rate(distance: int, reference_length: int) -> float | None:
    # Empty-reference hallucinations have insertion counts but no meaningful
    # denominator. Do not disguise them as a zero error rate.
    return distance / reference_length if reference_length else (0.0 if distance == 0 else None)


def evaluate_transcripts(reference: str, hypothesis: str, recipe: str, max_cells: int) -> dict:
    normalized_reference = normalize_text(reference, recipe)
    normalized_hypothesis = normalize_text(hypothesis, recipe)
    raw = edit_counts(reference, hypothesis, max_cells)
    expected_words = normalized_reference.split()
    observed_words = normalized_hypothesis.split()
    words = edit_counts(expected_words, observed_words, max_cells)
    return {
        "schema_version": 1,
        "scope": "Supplied text metrics only; no inference or hardware measurement",
        "native_inference_run": False,
        "unicode_version": unicodedata.unidata_version,
        "alignment_tie_break": ["substitution", "deletion", "insertion"],
        "raw": {
            "exact_match": reference == hypothesis,
            "character_alignment": raw,
            "character_error_rate": error_rate(raw["distance"], len(reference)),
            "reference_shape": text_shape(reference),
            "hypothesis_shape": text_shape(hypothesis),
        },
        "normalized": {
            "recipe": recipe,
            "operations": RECIPES[recipe],
            "reference_sha256": hashlib.sha256(normalized_reference.encode("utf-8")).hexdigest(),
            "hypothesis_sha256": hashlib.sha256(normalized_hypothesis.encode("utf-8")).hexdigest(),
            "reference_words": len(expected_words),
            "hypothesis_words": len(observed_words),
            "word_alignment": words,
            "word_error_rate": error_rate(words["distance"], len(expected_words)),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--hypothesis", type=Path, required=True)
    parser.add_argument("--normalization", choices=RECIPES, default="wer-basic-v1")
    parser.add_argument("--max-cells", type=int, default=4_000_000)
    parser.add_argument("--case-id", default="supplied-text-pair")
    parser.add_argument("--output", type=Path, help="Create a new JSON report; existing files are never replaced")
    args = parser.parse_args()
    if args.max_cells <= 0:
        parser.error("--max-cells must be positive")
    try:
        # Decode bytes directly: read_text() newline conversion would conceal
        # CRLF/LF differences that belong in raw formatting evaluation.
        reference_bytes = args.reference.read_bytes()
        hypothesis_bytes = args.hypothesis.read_bytes()
        report = evaluate_transcripts(reference_bytes.decode("utf-8"), hypothesis_bytes.decode("utf-8"), args.normalization, args.max_cells)
        report["case_id"] = args.case_id
        report["reference_sha256"] = hashlib.sha256(reference_bytes).hexdigest()
        report["hypothesis_sha256"] = hashlib.sha256(hypothesis_bytes).hexdigest()
        report["evaluator_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        output = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        if args.output:
            with args.output.open("x", encoding="utf-8", newline="\n") as target:
                target.write(output)
        else:
            print(output, end="")
    except (OSError, UnicodeError, ValueError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
