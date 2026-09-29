"""Opt-in Parakeet TDT 0.6B v3 external control, never an app speech option."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import time
import wave

from evaluation_report import build_report, validate_provenance
from native_audio_benchmark import audio_cases

MODEL = "nvidia/parakeet-tdt-0.6b-v3"
MODEL_CARD = "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3"


def run(args) -> None:
    manifest_bytes, cases = audio_cases(args.manifest)
    provenance = validate_provenance(json.loads(args.provenance.read_bytes()))
    if provenance["model"]["repository"] != MODEL or provenance["model"]["revision"] != args.revision:
        raise ValueError("Provenance must identify the exact Parakeet control revision")
    if provenance["decode"]["precision"] != args.precision:
        raise ValueError("Provenance precision must match the selected control dtype")
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
    import numpy as np
    import torch
    from huggingface_hub import snapshot_download
    from transformers import AutoModelForTDT, AutoProcessor
    if args.device == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA requested but unavailable; no CPU fallback")
    if args.device == "cpu" and args.precision != "float32":
        raise ValueError("CPU control runs require explicit float32 precision")
    if args.device == "cuda" and args.precision == "bfloat16" and not torch.cuda.is_bf16_supported():
        raise ValueError("Selected CUDA GPU does not support bfloat16")
    snapshot = snapshot_download(repo_id=MODEL, revision=args.revision, cache_dir=str(args.cache_dir / "hub"), local_files_only=True)
    args.output_directory.mkdir()
    (args.output_directory / "audio-manifest.json").write_bytes(manifest_bytes)
    metadata = {"schema": "delulu-external-parakeet-run-v1", "created_utc": datetime.now(timezone.utc).isoformat(),
                "role": "external-benchmark-control", "model_repository": MODEL, "model_revision": args.revision,
                "license": "CC-BY-4.0", "attribution": "NVIDIA, Parakeet TDT 0.6B v3", "model_card": MODEL_CARD,
                "device": args.device, "precision": args.precision, "native_inference_run": False,
                "repetitions": args.repetitions, "status": "running", "provenance_supplied": provenance,
                "installed_dependencies": {name: importlib.metadata.version(name) for name in ("torch", "transformers", "numpy", "huggingface-hub")},
                "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    model = None
    try:
        started = time.perf_counter()
        processor = AutoProcessor.from_pretrained(snapshot, local_files_only=True)
        if processor.feature_extractor.sampling_rate != 16000:
            raise ValueError("Control processor does not accept the corpus's 16 kHz input rate")
        model = AutoModelForTDT.from_pretrained(snapshot, dtype=getattr(torch, args.precision), device_map=args.device, local_files_only=True).eval()

        def synchronize():
            if args.device == "cuda":
                torch.cuda.synchronize()

        def infer(samples):
            inputs = processor([samples], sampling_rate=16000)
            inputs.to(model.device, dtype=model.dtype)
            with torch.inference_mode():
                output = model.generate(**inputs, return_dict_in_generate=True)
            decoded = processor.decode(output.sequences, skip_special_tokens=True)
            if isinstance(decoded, list) and len(decoded) == 1:
                decoded = decoded[0]
            if not isinstance(decoded, str):
                raise ValueError("External control returned an invalid single-utterance transcript")
            return decoded

        infer(np.zeros(16000, dtype=np.float32))
        synchronize()
        metadata["load_and_warmup_seconds"] = time.perf_counter() - started
        ordinal = 0
        with (args.output_directory / "measurements.jsonl").open("x", encoding="utf-8", newline="\n") as measurements:
            for repetition in range(1, args.repetitions + 1):
                for index, case in enumerate(cases, 1):
                    if hashlib.sha256(case["audio"].read_bytes()).hexdigest() != case["audio_sha256"]:
                        raise ValueError("Audio changed since manifest loading")
                    with wave.open(str(case["audio"]), "rb") as audio:
                        samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2").astype(np.float32) / 32768
                    ordinal += 1
                    synchronize()
                    started = time.perf_counter()
                    text = infer(samples)
                    synchronize()
                    elapsed = time.perf_counter() - started
                    if hashlib.sha256(case["audio"].read_bytes()).hexdigest() != case["audio_sha256"]:
                        raise ValueError("Audio changed during control inference")
                    metadata["native_inference_run"] = True
                    prefix = f"case-{index:04d}-run-{repetition:03d}"
                    hypothesis = text.encode("utf-8")
                    (args.output_directory / f"{prefix}-hypothesis.txt").write_bytes(hypothesis)
                    actual = json.loads(json.dumps(provenance))
                    actual["decode"]["language"] = "auto"
                    actual["hypothesis_origin"] = f"External Parakeet control, ordinal {ordinal}"
                    report = build_report(case["reference"], hypothesis, actual, case["case_id"], args.normalization, args.max_cells)
                    report["native_runner"] = {"actual_inference_completed": True, "role": "external-benchmark-control",
                                               "audio_sha256": case["audio_sha256"], "corpus_language": case["language"], "repetition": repetition}
                    (args.output_directory / f"{prefix}-report.json").write_text(json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")
                    measurements.write(json.dumps({"case_id": case["case_id"], "audio_sha256": case["audio_sha256"],
                                                   "repetition": repetition, "request_ordinal": ordinal, "wall_seconds": elapsed,
                                                   "phase": "first-request" if ordinal == 1 else "warm-request",
                                                   "timing_scope": "Predecoded PCM to generated and decoded text; CUDA synchronized"}) + "\n")
                    measurements.flush()
        metadata["status"] = "completed"
    except BaseException:
        metadata["status"] = "interrupted-or-failed"
        raise
    finally:
        model = None
        if args.device == "cuda":
            torch.cuda.empty_cache()
        (args.output_directory / "run.json").write_text(json.dumps(metadata, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute-native", action="store_true")
    parser.add_argument("--revision", required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--provenance", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--output-directory", type=Path, required=True)
    parser.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    parser.add_argument("--precision", choices=("float32", "float16", "bfloat16"), default="bfloat16")
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--normalization", choices=("none", "wer-basic-v1"), default="wer-basic-v1")
    parser.add_argument("--max-cells", type=int, default=4_000_000)
    args = parser.parse_args()
    if not args.execute_native:
        parser.error("External model loading/inference requires --execute-native")
    if not re.fullmatch(r"[0-9a-fA-F]{40}", args.revision) or not 1 <= args.repetitions <= 20 or args.max_cells <= 0:
        parser.error("Require full immutable revision SHA, 1–20 repetitions and positive max-cells")
    try:
        run(args)
    except (OSError, UnicodeError, ValueError, ImportError, RuntimeError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
