"""R2T2 inference directly on Apple Silicon through MLX Audio.

The BF16 checkpoint is an unquantized MLX conversion of Confucius4-R2T2,
not a substitution with the smaller base Qwen model. No CUDA, vLLM server,
or local HTTP endpoint is involved. Dependencies and model revision are pinned.
The direct generate API transcribes buffered audio; it does not implement
R2T2's acoustic streaming/committed-prefix protocol.
"""
from __future__ import annotations

import gc
import os
import sys
import time
from pathlib import Path

MODEL = "mlx-community/Confucius4-R2T2-bf16"
MODEL_REVISION = "747f5fc5f84bc9976baa2f02714e2fed67ed8611"
SAMPLE_RATE = 16000
MAX_TOKENS = 4096
# The pinned encoder constructs a dense attention mask even for its local
# attention windows. Bound each chunk to keep long imports within Mac memory.
CHUNK_SECONDS = 30.0


def progress(detail: str) -> None:
    sys.__stdout__.write("@delulu-progress:" + detail + "\n")
    sys.__stdout__.flush()


class MetalSpeech:
    def __init__(self):
        self.model = None

    def status(self):
        return {"loaded": self.model is not None, "model": MODEL, "device": "mlx"}

    def load(self, request):
        if self.model is not None:
            return self.status()
        import mlx.core as mx
        from huggingface_hub import snapshot_download
        from mlx_audio.stt.utils import load_model

        if not mx.metal.is_available():
            raise RuntimeError("R2T2 MLX requires a native Apple Silicon Mac with Metal available.")
        cache_root = request.get("cacheDir")
        progress("Downloading the pinned R2T2 BF16 MLX checkpoint (~4.1 GB)…")
        model_path = snapshot_download(
            repo_id=MODEL,
            revision=MODEL_REVISION,
            cache_dir=str(Path(cache_root) / "hub") if cache_root else None,
            local_files_only=os.environ.get("HF_HUB_OFFLINE") == "1",
            allow_patterns=["*.json", "*.safetensors", "*.model", "*.txt", "*.tiktoken"],
        )
        progress("Loading R2T2 with MLX and warming up speech inference…")
        try:
            self.model = load_model(Path(model_path), strict=True)
            # Exercise the full decoder before reporting Ready. Warmup output
            # is discarded and never enters transcript history or delivery.
            self.model.generate(
                mx.zeros(SAMPLE_RATE, dtype=mx.float32),
                language="English", max_tokens=8, verbose=False,
            )
            return self.status()
        except BaseException:
            # Loading itself can fail after allocating Metal buffers, before
            # load_model returns an object that we can assign to self.model.
            self.model = None
            gc.collect()
            mx.clear_cache()
            raise

    def transcribe(self, request):
        if self.model is None:
            raise RuntimeError("R2T2 is not loaded. Load the model to try again.")
        audio = Path(request["audioPath"])
        if not audio.is_file():
            raise FileNotFoundError("The selected audio file no longer exists")
        from mlx_audio.stt.utils import load_audio
        import mlx.core as mx
        from transcription_engine import LANGUAGE_NAMES

        started = time.perf_counter()
        # MLX Audio decodes and mixes/resamples locally. FLAC imports no longer
        # enter wave.open(), which only understands RIFF WAV files.
        samples = load_audio(str(audio), sr=SAMPLE_RATE)
        if not len(samples):
            raise ValueError("The selected audio file contains no samples")
        language_code = str(request.get("language", "en")).lower()
        language = LANGUAGE_NAMES.get(language_code)
        inference_started = time.perf_counter()
        try:
            result = self.model.generate(
                samples, language=language, max_tokens=MAX_TOKENS,
                chunk_duration=CHUNK_SECONDS,
                temperature=0.0, verbose=False,
            )
        finally:
            # Upstream clears its decode cache on successful chunks only.
            # Release allocator buffers after failed generations as well.
            mx.clear_cache()
        finished = time.perf_counter()
        if not isinstance(getattr(result, "text", None), str):
            raise RuntimeError("R2T2 returned an invalid transcription response")
        if getattr(result, "generation_tokens", 0) >= MAX_TOKENS:
            raise RuntimeError(
                "R2T2 reached its transcription length limit. Split the audio into shorter files and try again."
            )
        # MLX Audio returns one language label per decoded segment (the prompt
        # language when forced). Mixed labels stay unknown; this is not an
        # independent code-switching detector.
        detected = getattr(result, "language", None)
        if isinstance(detected, list):
            languages = {item.strip().lower() for item in detected if isinstance(item, str) and item.strip()}
            detected = next(iter(languages)) if len(languages) == 1 else None
        detected = detected.strip().lower() if isinstance(detected, str) else "und"
        code = {name.lower(): code for code, name in LANGUAGE_NAMES.items()}.get(detected, detected)
        return {"text": result.text.strip(), "language": code or "und",
                "duration": len(samples) / SAMPLE_RATE,
                "processingTime": finished - started,
                "inferenceTime": finished - inference_started}

    def unload(self):
        loaded = self.model is not None
        self.model = None
        gc.collect()
        if loaded:
            import mlx.core as mx
            mx.clear_cache()
        return {"loaded": False}
