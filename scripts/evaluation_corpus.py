"""Package supplied, consent-declared Dutch/English recordings for local evaluation.

No recording, downloads, synthetic evidence, native inference or upload occurs.
Consent/conditions/accent annotations remain explicit operator declarations.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
from pathlib import Path
import shutil
import wave

from evaluation_report import require_text

REQUIRED_CATEGORIES = {"quiet", "noise", "accents", "names", "code-switching"}
ALLOWED_CATEGORIES = REQUIRED_CATEGORIES | {"silence", "technical"}


def validate_case(case: dict, directory: Path) -> dict:
    case_id = require_text(case.get("case_id"), "case_id")
    consent = case.get("consent")
    if not isinstance(consent, dict) or consent.get("local_evaluation_allowed") is not True or consent.get("revoked") is not False:
        raise ValueError("Every recording needs explicit, unrevoked local evaluation consent metadata")
    require_text(consent.get("record_id"), "consent.record_id")
    recorded = datetime.fromisoformat(require_text(consent.get("recorded_at"), "consent.recorded_at").replace("Z", "+00:00"))
    if recorded.tzinfo is None:
        raise ValueError("Consent recorded_at must include a timezone")
    speaker = require_text(case.get("speaker_id"), "pseudonymous speaker_id")
    languages = case.get("languages")
    if not isinstance(languages, list) or not languages or len(languages) != len(set(languages)) or any(language not in {"nl", "en"} for language in languages):
        raise ValueError("languages must identify nl/en without duplicates")
    categories = case.get("categories")
    if not isinstance(categories, list) or not categories or any(category not in ALLOWED_CATEGORIES for category in categories) or len(categories) != len(set(categories)):
        raise ValueError("Case categories must use unique documented labels")
    if "code-switching" in categories and set(languages) != {"nl", "en"}:
        raise ValueError("Code-switching cases must explicitly identify both Dutch and English")
    accent = case.get("accent_description")
    if "accents" in categories:
        require_text(accent, "speaker/operator supplied accent_description")
    audio = directory / require_text(case.get("audio"), "audio path")
    reference = directory / require_text(case.get("reference"), "reference path")
    text_bytes = reference.read_bytes()
    text = text_bytes.decode("utf-8")
    if "silence" in categories and text.strip():
        raise ValueError("Silence cases require an empty reference")
    if "silence" not in categories and not text.strip():
        raise ValueError("Speech cases require a nonempty human reference")
    with wave.open(str(audio), "rb") as source:
        if (source.getnchannels(), source.getframerate(), source.getsampwidth(), source.getcomptype()) != (1, 16000, 2, "NONE") or source.getnframes() <= 0:
            raise ValueError("Recordings must be nonempty 16 kHz mono PCM16 WAV")
        frame_count = source.getnframes()
        if len(source.readframes(frame_count)) != frame_count * 2:
            raise ValueError("Recording contains truncated PCM frames")
    entities = case.get("named_entities", [])
    if not isinstance(entities, list) or any(not isinstance(entity, str) or not entity or entity not in text for entity in entities):
        raise ValueError("Named entity annotations must occur exactly in the reference")
    return {"case_id": case_id, "audio_source": audio, "reference_bytes": text_bytes,
            "languages": languages, "categories": categories, "speaker_id": speaker,
            "consent": consent, "accent_description": accent, "named_entities": entities,
            "duration_seconds": frame_count / 16000}


def package(manifest_path: Path, destination: Path, allow_incomplete: bool) -> None:
    contents = manifest_path.read_bytes()
    manifest = json.loads(contents)
    if not isinstance(manifest, dict) or not isinstance(manifest.get("cases"), list) or not manifest["cases"]:
        raise ValueError("Corpus manifest needs nonempty cases")
    cases, ids = [], set()
    for case in manifest["cases"]:
        if not isinstance(case, dict):
            raise ValueError("Cases must be objects")
        validated = validate_case(case, manifest_path.parent)
        if validated["case_id"] in ids:
            raise ValueError("Corpus case IDs must be unique")
        ids.add(validated["case_id"])
        cases.append(validated)
    category_counts = Counter(category for case in cases for category in case["categories"])
    language_counts = Counter(language for case in cases for language in case["languages"])
    missing_categories = sorted(REQUIRED_CATEGORIES - set(category_counts))
    missing_languages = sorted({"nl", "en"} - set(language_counts))
    complete = not missing_categories and not missing_languages
    if not complete and not allow_incomplete:
        raise ValueError(f"Incomplete coverage: categories {missing_categories}, languages {missing_languages}; use --allow-incomplete to package an explicitly incomplete draft")
    destination.mkdir()
    try:
        (destination / "audio").mkdir()
        (destination / "references").mkdir()
        outputs = []
        for index, case in enumerate(cases, 1):
            audio_relative = f"audio/case-{index:04d}.wav"
            reference_relative = f"references/case-{index:04d}.txt"
            digest = hashlib.sha256()
            target = destination / audio_relative
            with case["audio_source"].open("rb") as source, target.open("xb") as output:
                while block := source.read(1024 * 1024):
                    output.write(block)
                    digest.update(block)
            (destination / reference_relative).write_bytes(case["reference_bytes"])
            outputs.append({"case_id": case["case_id"], "audio": audio_relative, "reference": reference_relative,
                            "language": case["languages"][0] if len(case["languages"]) == 1 else "auto",
                            "languages": case["languages"], "categories": case["categories"],
                            "speaker_id": case["speaker_id"], "accent_description": case["accent_description"],
                            "consent_recorded": True, "consent": case["consent"],
                            "annotations": {"speech_present": "silence" not in case["categories"], "named_entities": case["named_entities"]},
                            "duration_seconds": case["duration_seconds"], "audio_sha256": digest.hexdigest(),
                            "reference_sha256": hashlib.sha256(case["reference_bytes"]).hexdigest()})
        report = {"schema": "delulu-consented-corpus-v1", "cases": outputs,
                  "coverage": {"case_count": len(cases), "unique_speaker_count": len({case["speaker_id"] for case in cases}),
                               "category_counts": dict(category_counts), "language_counts": dict(language_counts),
                               "missing_categories": missing_categories, "missing_languages": missing_languages,
                               "declared_coverage_complete": complete},
                  "source_manifest_sha256": hashlib.sha256(contents).hexdigest(),
                  "builder_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  "scope": "Local supplied recordings; no upload or native inference",
                  "verification": "Consent, accent and acoustic condition labels are operator declarations; not independently established",
                  "sharing_authorized": False}
        (destination / "corpus.json").write_text(json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")
        (destination / "source-manifest.json").write_bytes(contents)
    except BaseException:
        shutil.rmtree(destination)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output-directory", type=Path, required=True)
    parser.add_argument("--allow-incomplete", action="store_true")
    args = parser.parse_args()
    try:
        package(args.manifest, args.output_directory, args.allow_incomplete)
    except (OSError, UnicodeError, ValueError, TypeError, wave.Error) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
