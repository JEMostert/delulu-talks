"""Small and Medium speech on the CPU through sherpa-onnx (Linux, Windows, macOS).

Small is NVIDIA Canary 180M Flash (English, German, French, Spanish). Medium is
NVIDIA Parakeet TDT 0.6B: v2 for English, v3 for automatic detection across 25
European languages. All use the INT8 ONNX exports published by the sherpa-onnx
project, pinned to immutable revisions. No PyTorch, GPU or network is needed
once the checkpoint is downloaded. NVIDIA weights are CC BY 4.0.
"""
from __future__ import annotations

import gc
import os
import sys
import time
from pathlib import Path
from typing import Any

from audio_input import SAMPLE_RATE, chunk_bounds, read_audio
from worker_protocol import emit_progress

CHECKPOINTS: dict[str, dict[str, Any]] = {
    "canary-180m": {
        "name": "Canary 180M Flash",
        "family": "canary",
        "repository": "csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8",
        "revision": "9077164e0d3dd1d5353743e89ceaa1d3a770838c",
        "files": ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"],
        "languages": ("en", "de", "fr", "es"),
        # Canary was trained on utterances up to 40 seconds.
        "chunkSeconds": 30,
    },
    "parakeet-v2": {
        "name": "Parakeet TDT 0.6B v2",
        "family": "parakeet",
        "repository": "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
        "revision": "1ab9323565ddb038682214b292f588070a538ce2",
        "files": ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
        "languages": ("en",),
        "chunkSeconds": 60,
    },
    "parakeet-v3": {
        "name": "Parakeet TDT 0.6B v3",
        "family": "parakeet",
        "repository": "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
        "revision": "2bda32ec70b097a55adaa07d9a7173915b43cc78",
        "files": ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
        # Detects the language itself; it does not accept a forced language.
        "languages": (),
        "chunkSeconds": 60,
    },
}


def threads() -> int:
    return max(1, min(4, os.cpu_count() or 1))


class OnnxSpeech:
    def __init__(self, model: str) -> None:
        if model not in CHECKPOINTS:
            raise ValueError(f"Unsupported speech model: {model}")
        self.model = model
        self.checkpoint = CHECKPOINTS[model]
        self.directory: str | None = None
        # Canary takes its language when the recognizer is created; keep one
        # per language so switching between dictations does not reload.
        self.recognizers: dict[str, Any] = {}
        self.warmup = "not-started"

    def status(self) -> dict[str, Any]:
        loaded = bool(self.recognizers)
        result = {"loaded": loaded, "model": self.checkpoint["repository"],
                  "device": "cpu" if loaded else None,
                  "residency": "resident" if loaded else "unloaded", "warmup": self.warmup}
        if loaded:
            result["speechExecution"] = {
                "modelId": self.checkpoint["family"], "backendId": "onnx-cpu", "precision": "int8",
                "checkpoint": {"repository": self.checkpoint["repository"],
                               "revision": self.checkpoint["revision"]},
                "platform": sys.platform,
                "device": "cpu"}
        return result

    def _language(self, request: dict[str, Any]) -> str:
        supported = self.checkpoint["languages"]
        if not supported:
            return "auto"
        code = str(request.get("language") or supported[0]).lower()
        if code not in supported:
            raise ValueError(f"{self.checkpoint['name']} supports {', '.join(supported)}; choose one of these languages in Settings.")
        return code

    def _recognizer(self, language: str):
        if language in self.recognizers:
            return self.recognizers[language]
        import sherpa_onnx
        directory = Path(str(self.directory))
        if self.checkpoint["family"] == "canary":
            recognizer = sherpa_onnx.OfflineRecognizer.from_nemo_canary(
                encoder=str(directory / "encoder.int8.onnx"), decoder=str(directory / "decoder.int8.onnx"),
                tokens=str(directory / "tokens.txt"), src_lang=language, tgt_lang=language,
                num_threads=threads())
        else:
            recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
                encoder=str(directory / "encoder.int8.onnx"), decoder=str(directory / "decoder.int8.onnx"),
                joiner=str(directory / "joiner.int8.onnx"), tokens=str(directory / "tokens.txt"),
                num_threads=threads(), model_type="nemo_transducer")
        self.recognizers[language] = recognizer
        return recognizer

    def _decode(self, recognizer, samples) -> str:
        stream = recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, samples)
        recognizer.decode_stream(stream)
        return str(stream.result.text).strip()

    def load(self, request: dict[str, Any]) -> dict[str, Any]:
        if self.recognizers:
            return self.status()
        import numpy as np
        from verified_snapshot import verified_snapshot

        cache_root = request.get("cacheDir")
        emit_progress(f"Downloading the pinned {self.checkpoint['name']} checkpoint…", stage="download")
        self.directory = verified_snapshot(
            repo_id=self.checkpoint["repository"], revision=self.checkpoint["revision"],
            cache_dir=str(Path(cache_root) / "hub") if cache_root else None,
            local_files_only=os.environ.get("HF_HUB_OFFLINE") == "1",
            allow_patterns=list(self.checkpoint["files"]), weights_suffix=".onnx",
        )
        emit_progress(f"Loading {self.checkpoint['name']} on the CPU…", stage="load")
        try:
            recognizer = self._recognizer(self._language(request))
            self.warmup = "warming"
            emit_progress("Warming up local CPU speech inference…", stage="warmup")
            self._decode(recognizer, np.zeros(SAMPLE_RATE, dtype=np.float32))
            self.warmup = "complete"
            return self.status()
        except BaseException:
            self.unload()
            raise

    def unload(self) -> dict[str, Any]:
        self.recognizers = {}
        self.warmup = "not-started"
        gc.collect()
        return self.status()

    def transcribe(self, request: dict[str, Any]) -> dict[str, Any]:
        if not self.recognizers:
            raise RuntimeError("No model is loaded")
        language = self._language(request)
        started = time.perf_counter()
        samples, duration = read_audio(str(request.get("audioPath", "")))
        recognizer = self._recognizer(language)
        inference_started = time.perf_counter()
        chunk = self.checkpoint["chunkSeconds"] * SAMPLE_RATE
        text = " ".join(part for part in (self._decode(recognizer, samples[start:end])
                                          for start, end in chunk_bounds(samples, chunk)) if part)
        finished = time.perf_counter()
        return {"text": text, "language": language, "requestedLanguage": language,
                "recognizedLanguage": None, "recognizedLanguages": [], "languageStatus": "unknown",
                "duration": duration, "processingTime": finished - started,
                "inferenceTime": finished - inference_started,
                "timings": {"backendPreprocessingMs": (inference_started - started) * 1000,
                            "inferenceMs": (finished - inference_started) * 1000}}
