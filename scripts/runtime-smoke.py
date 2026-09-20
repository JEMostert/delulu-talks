"""Opt-in real inference smoke check. Run with the app's venv Python and --cache.
Uses only pre-downloaded models; never prints transcript contents or modifies source audio.
Requires a CUDA GPU for the R2T2 speech engine.
"""
import argparse
import importlib.util
import json
import os
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
    print(json.dumps(report, indent=2))
finally:
    worker.dispatch({"command": "shutdown"})
