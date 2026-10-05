"""Parakeet Redux packed ternary CPU adapter using Photon's Kestrel runtime.

Use the runtime directly: no Photon API client, account, telemetry or network
is involved in inference. Moondream / NVIDIA weights are CC BY 4.0.
"""
from __future__ import annotations

import gc
import os
import sys
import time
from pathlib import Path
from typing import Any

from worker_protocol import emit_progress

MODEL = "moondream/parakeet-redux"
REVISION = "2bf128600aac4b16946f7ed8372e56117fe5e23b"
DEFAULT_DIRECTORY = Path.home() / ".local/share/models/parakeet-redux"


class ReduxSpeech:
    def __init__(self) -> None:
        self.runtime = None
        self.warmup = "not-started"

    def status(self) -> dict[str, Any]:
        loaded = self.runtime is not None
        result = {"loaded": loaded, "model": MODEL, "device": "cpu" if loaded else None,
                  "residency": "resident" if loaded else "unloaded", "warmup": self.warmup}
        if loaded:
            result["speechExecution"] = {"modelId": "redux", "backendId": "photon-cpu",
                "precision": None, "checkpoint": {"repository": MODEL, "revision": REVISION},
                "platform": sys.platform, "device": "cpu"}
        return result

    def load(self, request: dict[str, Any]) -> dict[str, Any]:
        if self.runtime is not None:
            return self.status()
        import numpy as np
        import torch
        from kestrel.config import RuntimeConfig
        from kestrel.models.parakeet_tdt.runtime import ParakeetTdtRuntime

        directory = Path(os.environ.get("DELULU_REDUX_MODEL_DIR", str(DEFAULT_DIRECTORY)))
        for name in ("config.json", "tokenizer.json", "ternary.json", "model.safetensors", "revision.txt"):
            if not (directory / name).is_file():
                raise FileNotFoundError("Required Parakeet Redux checkpoint file missing")
        if (directory / "revision.txt").read_text().strip() != REVISION:
            raise ValueError("Parakeet Redux checkpoint revision mismatch")
        emit_progress("Loading Parakeet Redux packed weights on CPU…", stage="load")
        try:
            self.runtime = ParakeetTdtRuntime(RuntimeConfig(
                model=MODEL, model_path=str(directory), device="cpu", dtype=torch.float32,
                cpu_threads=min(4, os.cpu_count() or 1), single_pass_batch_capacity=1,
                enable_cuda_graphs=False,
            ))
            self.warmup = "warming"
            emit_progress("Warming up local CPU speech inference…", stage="warmup")
            result = self.runtime.forward("transcribe", [{"audio": np.zeros(16000, dtype=np.float32), "sample_rate": 16000}])[0]
            if isinstance(result, Exception):
                raise result
            self.warmup = "complete"
            return self.status()
        except BaseException:
            self.unload()
            raise

    def unload(self) -> dict[str, Any]:
        runtime, self.runtime = self.runtime, None
        self.warmup = "not-started"
        if runtime is not None:
            runtime.shutdown()
        del runtime
        gc.collect()
        return self.status()

    def transcribe(self, request: dict[str, Any]) -> dict[str, Any]:
        if self.runtime is None:
            raise RuntimeError("No model is loaded")
        source = Path(str(request.get("audioPath", "")))
        if not source.is_file():
            raise FileNotFoundError("Audio file unavailable")
        import soundfile as sf
        import soxr
        started = time.perf_counter()
        samples, rate = sf.read(str(source), dtype="float32", always_2d=False)
        if samples.ndim > 1:
            samples = samples.mean(axis=1)
        duration = len(samples) / rate
        if rate != 16000:
            samples = soxr.resample(samples, rate, 16000)
        inference_started = time.perf_counter()
        result = self.runtime.forward("transcribe", [{"audio": samples, "sample_rate": 16000}])[0]
        if isinstance(result, Exception):
            raise result
        elapsed = time.perf_counter() - inference_started
        return {"text": str(result["text"]).strip(), "language": "auto", "recognizedLanguage": None,
                "recognizedLanguages": [], "languageStatus": "unknown", "duration": duration,
                "processingTime": time.perf_counter() - started, "inferenceTime": elapsed,
                "timings": {"backendPreprocessingMs": (inference_started - started) * 1000,
                            "inferenceMs": elapsed * 1000}}
