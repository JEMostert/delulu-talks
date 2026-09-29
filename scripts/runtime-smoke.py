"""Opt-in real inference smoke check. Run with the app's venv Python and --cache.
Uses only pre-downloaded models; never prints transcript contents or modifies source audio.
Requires Apple Silicon for MLX or an NVIDIA CUDA GPU for Linux vLLM / Windows PyTorch.
"""
import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import os
import sys
from pathlib import Path
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument("--cache", required=True)
parser.add_argument("--magic", action="store_true")
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
os.environ.update({"HF_HUB_OFFLINE": "1", "HF_HOME": args.cache, "HF_HUB_CACHE": str(Path(args.cache) / "hub")})
sys.path.insert(0, str(root / "electron/python"))
spec = importlib.util.spec_from_file_location("engine", root / "electron/python/transcription_engine.py")
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)
worker = engine.Worker()
report = {}
try:
    start = time.monotonic()
    worker.dispatch({"command": "load", "cacheDir": args.cache})
    report["speechLoadSeconds"] = round(time.monotonic() - start, 2)
    with tempfile.TemporaryDirectory(prefix="delulu-smoke-") as temporary:
        wav = str(Path(temporary) / "sample.wav")
        subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(root / "test-audio.m4a"), "-ar", "16000", "-ac", "1", wav], check=True)
        result = worker.dispatch({"command": "transcribe", "audioPath": wav, "language": "en"})
        assert result["text"].strip(), "Missing transcript"
        report["speech"] = {"characters": len(result["text"]), "processingSeconds": round(result["processingTime"], 2)}
    if args.magic:
        worker.dispatch({"command": "magicLoad", "model": "qwen35Medium", "cacheDir": args.cache})
        result = worker.dispatch({"command": "magicRewrite", "text": "um please move the design review to Thursday", "preset": "polish", "allowInferences": False})
        assert result["text"].strip(), "Missing Magic output"
        assert "Thursday" in result["text"], "Magic lost the requested day"
        report["magic"] = {"characters": len(result["text"]), "processingTimeMs": result["processingTimeMs"]}
    evidence_path = os.environ.get("DELULU_EVIDENCE_NATIVE_RESULT")
    if evidence_path:
        speech = worker.dispatch({"command": "status"})
        versions = {}
        for package in ("mlx", "mlx-audio", "torch", "transformers", "vllm", "qwen-asr"):
            try:
                versions[package] = importlib.metadata.version(package)
            except importlib.metadata.PackageNotFoundError:
                pass
        observation = {
            "model": speech["model"], "device": speech["device"],
            "backend": "mlx" if speech["device"] == "mlx" else "cuda-transformers" if sys.platform == "win32" else "cuda-vllm",
            "backendSource": "worker device and platform",
            "fixtureSha256": hashlib.sha256((root / "test-audio.m4a").read_bytes()).hexdigest(),
            "characters": report["speech"]["characters"],
            "pythonVersion": sys.version, "packageVersions": versions,
            "measurements": report,
        }
        Path(evidence_path).write_text(json.dumps(observation), encoding="utf8")
    print(json.dumps(report, indent=2))
finally:
    worker.dispatch({"command": "shutdown"})
