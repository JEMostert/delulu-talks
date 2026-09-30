"""R2T2 inference directly on Apple Silicon through MLX Audio.

The BF16 checkpoint is an unquantized MLX conversion of Confucius4-R2T2,
not a substitution with the smaller base Qwen model. No CUDA, vLLM server,
or local HTTP endpoint is involved. Dependencies and model revision are pinned.
The direct generate API transcribes buffered audio; it does not implement
R2T2's acoustic streaming/committed-prefix protocol.
"""
from __future__ import annotations

import contextlib
import gc
import os
import time
from pathlib import Path

from worker_protocol import emit_progress

MODEL = "mlx-community/Confucius4-R2T2-bf16"
MODEL_REVISION = "747f5fc5f84bc9976baa2f02714e2fed67ed8611"
SAMPLE_RATE = 16000
MAX_TOKENS = 4096
# The pinned encoder constructs a dense attention mask even for its local
# attention windows. Bound each chunk to keep long imports within Mac memory.
CHUNK_SECONDS = 30.0


def progress(detail: str, stage: str = "load") -> None:
    emit_progress(detail, stage=stage)


class MetalSpeech:
    def __init__(self):
        self.model = None
        self.warmup = "not-started"

    def status(self):
        loaded = self.model is not None
        return {"loaded": loaded, "model": MODEL, "device": "mlx" if loaded else None,
                "residency": "resident" if loaded else "unloaded", "warmup": self.warmup}

    def load(self, request):
        if self.model is not None:
            return self.status()
        import mlx.core as mx
        from verified_snapshot import verified_snapshot
        from mlx_audio.stt.utils import load_model

        if not mx.metal.is_available():
            raise RuntimeError("R2T2 MLX requires a native Apple Silicon Mac with Metal available.")
        cache_root = request.get("cacheDir")
        progress("Downloading the pinned R2T2 BF16 MLX checkpoint (~4.1 GB)…", "download")
        model_path = verified_snapshot(
            repo_id=MODEL,
            revision=MODEL_REVISION,
            cache_dir=str(Path(cache_root) / "hub") if cache_root else None,
            local_files_only=os.environ.get("HF_HUB_OFFLINE") == "1",
            allow_patterns=["*.json", "*.safetensors", "*.model", "*.txt", "*.tiktoken"],
        )
        progress("Loading R2T2 with MLX…", "load")
        try:
            self.model = load_model(Path(model_path), strict=True)
            self.warmup = "warming"
            progress("Warming up R2T2 speech inference…", "warmup")
            # Exercise the full decoder before reporting Ready. Warmup output
            # is discarded and never enters transcript history or delivery.
            self.model.generate(
                mx.zeros(SAMPLE_RATE, dtype=mx.float32),
                language="English", max_tokens=8, verbose=False,
            )
            self.warmup = "complete"
            return self.status()
        except BaseException:
            # Loading itself can fail after allocating Metal buffers, before
            # load_model returns an object that we can assign to self.model.
            self.model = None
            self.warmup = "not-started"
            gc.collect()
            with contextlib.suppress(Exception):
                mx.clear_cache()
            raise

    def transcribe(self, request):
        from transcription_engine import LANGUAGE_NAMES, language_hint
        language_code, language = language_hint(request)
        if self.model is None:
            raise RuntimeError("R2T2 is not loaded. Load the model to try again.")
        audio = Path(request["audioPath"])
        if not audio.is_file():
            raise FileNotFoundError("The selected audio file no longer exists")
        from mlx_audio.stt.utils import load_audio
        import mlx.core as mx
        from transcription_engine import LANGUAGE_NAMES, recognized_language_metadata

        started = time.perf_counter()
        # MLX Audio decodes and mixes/resamples locally. FLAC imports no longer
        # enter wave.open(), which only understands RIFF WAV files.
        samples = load_audio(str(audio), sr=SAMPLE_RATE)
        if not len(samples):
            raise ValueError("The selected audio file contains no samples")
        inference_started = time.perf_counter()
        try:
            result = self.model.generate(
                samples, language=language, max_tokens=MAX_TOKENS,
                chunk_duration=CHUNK_SECONDS,
                temperature=0.0, verbose=False,
            )
            inference_finished = time.perf_counter()
        finally:
            # Upstream clears its decode cache on successful chunks only.
            # Release allocator buffers after failed generations as well.
            with contextlib.suppress(Exception):
                mx.clear_cache()
        finished = time.perf_counter()
        if not isinstance(getattr(result, "text", None), str):
            raise RuntimeError("R2T2 returned an invalid transcription response")
        if getattr(result, "generation_tokens", 0) >= MAX_TOKENS:
            raise RuntimeError(
                "R2T2 reached its transcription length limit. Split the audio into shorter files and try again."
            )
        # MLX Audio returns one language label per decoded segment (the prompt
        # language when forced). Mixed labels have no single code; this is not an
        # independent code-switching detector.
        language_metadata = recognized_language_metadata(getattr(result, "language", None))
        return {"text": result.text.strip(), "language": language_metadata["recognizedLanguage"] or "und",
                "requestedLanguage": language_code,
                **language_metadata,
                "duration": len(samples) / SAMPLE_RATE,
                "processingTime": finished - started,
                "inferenceTime": finished - inference_started,
                "timings": {
                    "backendPreprocessingMs": (inference_started - started) * 1000,
                    "inferenceMs": (inference_finished - inference_started) * 1000,
                }}

    def unload(self):
        loaded = self.model is not None
        self.model = None
        self.warmup = "not-started"
        gc.collect()
        if loaded:
            import mlx.core as mx
            with contextlib.suppress(Exception):
                mx.clear_cache()
        return self.status()
