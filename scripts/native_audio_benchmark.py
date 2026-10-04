"""Opt-in native same-audio benchmark; no settings/history or app model changes.

Run separately in each platform's installed speech environment. External base
Qwen3-ASR controls use Linux CUDA's qwen_asr engine only inside this process.
Requires explicit consent metadata and cached checkpoint revisions; no downloads.
"""
from __future__ import annotations

import argparse
import contextlib
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import sys
import time
import wave

from evaluation_report import build_report, require_text, validate_provenance

ROOT = Path(__file__).resolve().parent.parent


def audio_cases(manifest_path: Path) -> tuple[bytes, list]:
    contents = manifest_path.read_bytes()
    manifest = json.loads(contents)
    if not isinstance(manifest, dict) or not isinstance(manifest.get("cases"), list) or not manifest["cases"]:
        raise ValueError("Audio manifest needs nonempty cases")
    cases, seen = [], set()
    for case in manifest["cases"]:
        case_id = require_text(case.get("case_id"), "case_id")
        if case_id in seen:
            raise ValueError("Audio case IDs must be unique")
        seen.add(case_id)
        if case.get("consent_recorded") is not True:
            raise ValueError("Every case must explicitly record consent before native processing")
        language = require_text(case.get("language"), "language")
        if language not in {"nl", "en", "auto"}:
            raise ValueError("Evaluation corpus languages must be nl, en or auto for code switching")
        path = (manifest_path.parent / require_text(case.get("audio"), "audio path")).resolve()
        with wave.open(str(path), "rb") as audio:
            if (audio.getnchannels(), audio.getframerate(), audio.getsampwidth(), audio.getcomptype()) != (1, 16000, 2, "NONE") or not audio.getnframes():
                raise ValueError("Every adapter must receive the same nonempty 16 kHz mono PCM16 WAV; prepare imports separately")
            duration = audio.getnframes() / 16000
        reference = (manifest_path.parent / require_text(case.get("reference"), "reference path")).read_bytes()
        reference.decode("utf-8")
        cases.append({"case_id": case_id, "audio": path, "audio_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                      "reference": reference, "language": language, "duration_seconds": duration})
    return contents, cases


def bind_worker(args):
    sys.path.insert(0, str(ROOT / "electron/python"))
    import transcription_engine as engine
    worker = engine.Worker()
    expected = {"mlx": "mlx", "cuda-windows": "cuda", "cuda-linux": "cuda", "external-qwen3-asr": "cuda"}[args.backend]
    if worker.speech_backend != expected:
        raise ValueError("Selected runner must execute on its native platform; cross-platform emulation is not supported")
    if args.backend == "mlx":
        import metal_speech as adapter
        identity = (adapter.MODEL, adapter.MODEL_REVISION)
    elif args.backend in ("cuda-windows", "cuda-linux"):
        import r2t2_speech as adapter
        identity = (adapter.MODEL, adapter.MODEL_REVISION)
    else:
        # The external base-Qwen control ran through the Linux vLLM worker,
        # which v0.12.0 removed; it needs its own runner before it can return.
        raise ValueError("The external Qwen3-ASR control is unavailable since v0.12.0 removed vLLM")
    return worker, identity


def run(args) -> None:
    manifest_bytes, cases = audio_cases(args.manifest)
    provenance = validate_provenance(json.loads(args.provenance.read_bytes()))
    # This script never installs packages or resolves weights over the network.
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HOME=str(args.cache_dir),
                      HF_HUB_CACHE=str(args.cache_dir / "hub"), HUGGINGFACE_HUB_CACHE=str(args.cache_dir / "hub"))
    worker, identity = bind_worker(args)
    if (provenance["model"]["repository"], provenance["model"]["revision"]) != identity:
        raise ValueError("Supplied provenance must identify the runner's actual pinned checkpoint")
    args.output_directory.mkdir()
    (args.output_directory / "audio-manifest.json").write_bytes(manifest_bytes)
    versions = {}
    for name in ("mlx", "mlx-audio", "torch", "transformers", "qwen-asr", "vllm", "soundfile", "soxr"):
        with contextlib.suppress(importlib.metadata.PackageNotFoundError):
            versions[name] = importlib.metadata.version(name)
    runtime = {"schema": "delulu-native-audio-run-v1", "created_utc": datetime.now(timezone.utc).isoformat(),
               "backend": args.backend, "role": "external-benchmark-control" if args.backend == "external-qwen3-asr" else "supported-r2t2-adapter",
               "model_repository": identity[0], "model_revision": identity[1],
               "host_os": platform.platform(), "host_architecture": platform.machine(),
               "python": platform.python_version(), "installed_dependencies": versions,
               "provenance_supplied": provenance, "repetitions": args.repetitions,
               "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               "adapter_source_sha256": {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                  for path in (ROOT / "electron/python").glob("*.py") if path.name in {"transcription_engine.py", "metal_speech.py", "r2t2_speech.py", "r2t2_checkpoint.py", "nemotron_speech.py"}},
               "status": "running", "native_inference_run": False}
    try:
        started = time.perf_counter()
        status = worker.load({"cacheDir": str(args.cache_dir)})
        runtime["load_and_warmup_seconds"] = time.perf_counter() - started
        runtime["loaded_status"] = status
        ordinal = 0
        with (args.output_directory / "measurements.jsonl").open("x", encoding="utf-8", newline="\n") as measurements:
            for repetition in range(1, args.repetitions + 1):
                for index, case in enumerate(cases, 1):
                    if hashlib.sha256(case["audio"].read_bytes()).hexdigest() != case["audio_sha256"]:
                        raise ValueError("Source audio changed during the run; comparison is invalid")
                    ordinal += 1
                    started = time.perf_counter()
                    result = worker.transcribe({"audioPath": str(case["audio"]), "language": case["language"]})
                    elapsed = time.perf_counter() - started
                    if hashlib.sha256(case["audio"].read_bytes()).hexdigest() != case["audio_sha256"]:
                        raise ValueError("Source audio changed during inference; comparison is invalid")
                    if not isinstance(result.get("text"), str):
                        raise ValueError("Adapter returned an invalid transcript")
                    runtime["native_inference_run"] = True
                    prefix = f"case-{index:04d}-run-{repetition:03d}"
                    hypothesis = result["text"].encode("utf-8")
                    (args.output_directory / f"{prefix}-hypothesis.txt").write_bytes(hypothesis)
                    case_provenance = json.loads(json.dumps(provenance))
                    case_provenance["decode"]["language"] = case["language"]
                    case_provenance["hypothesis_origin"] = f"native runner {args.backend}, ordinal {ordinal}"
                    report = build_report(case["reference"], hypothesis, case_provenance, case["case_id"], args.normalization, args.max_cells)
                    report["native_runner"] = {"actual_inference_completed": True, "audio_sha256": case["audio_sha256"],
                                               "repetition": repetition, "ordinal": ordinal, "backend": args.backend}
                    (args.output_directory / f"{prefix}-report.json").write_text(json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")
                    row = {"case_id": case["case_id"], "audio_sha256": case["audio_sha256"], "audio_seconds": case["duration_seconds"],
                           "repetition": repetition, "request_ordinal": ordinal, "phase": "first-request" if ordinal == 1 else "warm-request",
                           "wall_seconds": elapsed, "worker_processing_seconds": result.get("processingTime"),
                           "worker_inference_seconds": result.get("inferenceTime"), "hypothesis_sha256": hashlib.sha256(hypothesis).hexdigest()}
                    measurements.write(json.dumps(row, allow_nan=False) + "\n")
                    measurements.flush()
        runtime["status"] = "completed"
    except BaseException:
        runtime["status"] = "interrupted-or-failed"
        raise
    finally:
        with contextlib.suppress(Exception):
            worker.unload()
        (args.output_directory / "run.json").write_text(json.dumps(runtime, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute-native", action="store_true", help="Required explicit opt-in; loads cached weights and performs inference")
    parser.add_argument("--backend", choices=("mlx", "cuda-linux", "cuda-windows", "external-qwen3-asr"), required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--provenance", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--output-directory", type=Path, required=True)
    parser.add_argument("--control-repository")
    parser.add_argument("--control-revision")
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--normalization", choices=("none", "wer-basic-v1"), default="wer-basic-v1")
    parser.add_argument("--max-cells", type=int, default=4_000_000)
    args = parser.parse_args()
    if not args.execute_native:
        parser.error("Native loading/inference requires --execute-native; no work performed")
    if not 1 <= args.repetitions <= 20 or args.max_cells <= 0:
        parser.error("Repetitions must be within 1–20 and max-cells positive")
    try:
        run(args)
    except (OSError, UnicodeError, ValueError, ImportError, RuntimeError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
