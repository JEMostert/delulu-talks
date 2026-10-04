"""NVIDIA Nemotron 3.5 ASR Streaming (0.6B) through Transformers.

A cache-aware FastConformer-RNNT model: about 1.3 GB in BF16 on CUDA, and it
also runs on the CPU. Streaming reuses encoder caches, so every chunk is
processed once and RNNT tokens are final as soon as they are emitted. That is
what makes live typing safe: text that was pasted is never revised.
"""
from __future__ import annotations

import contextlib
import gc
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any

from worker_protocol import emit_progress
from stream_buffer import StreamBuffer

MODEL = "nvidia/nemotron-3.5-asr-streaming-0.6b"
MODEL_REVISION = "ea30d66debe3740a08b573244286791d423d6b3e"
SAMPLE_RATE = 16000
# 6 lookahead tokens is the model card's streaming setting (about half a second).
LOOKAHEAD_TOKENS = 6
LOCALES = {
    "en": "en-US", "nl": "nl-NL", "de": "de-DE", "fr": "fr-FR", "es": "es-ES",
    "it": "it-IT", "pt": "pt-PT", "pl": "pl-PL", "sv": "sv-SE", "da": "da-DK",
    "no": "nb-NO", "fi": "fi-FI", "cs": "cs-CZ", "ru": "ru-RU", "uk": "uk-UA",
    "tr": "tr-TR", "ja": "ja-JP", "ko": "ko-KR", "zh": "zh-CN", "ar": "ar-AR",
    "hi": "hi-IN", "vi": "vi-VN",
}


def locale(code: str | None) -> str:
    return LOCALES.get((code or "").split("-")[0].lower(), "auto")


def read_audio(path: Path):
    import soundfile as sf
    try:
        samples, rate = sf.read(str(path), dtype="float32", always_2d=False)
    except RuntimeError:
        import librosa
        samples, rate = librosa.load(str(path), sr=SAMPLE_RATE, mono=True)
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    if rate != SAMPLE_RATE:
        import soxr
        samples = soxr.resample(samples, rate, SAMPLE_RATE)
    return samples


class StreamSession:
    """Feeds audio into a running generate() and collects final text deltas."""

    def __init__(self, engine: "NemotronSpeech", language: str) -> None:
        import numpy as np
        self.np = np
        self.engine = engine
        self.language = language
        self.audio = StreamBuffer()
        self.closed = False
        self.flushed = False
        self.condition = threading.Condition()
        self.text: list[str] = []
        self.error: BaseException | None = None
        processor = engine.processor
        self.first = processor.num_samples_first_audio_chunk
        self.per_chunk = processor.num_samples_per_audio_chunk
        self.hop = processor.feature_extractor.hop_length
        self.n_fft = processor.feature_extractor.n_fft
        self.thread: threading.Thread | None = None
        self.reader: threading.Thread | None = None

    def _wait_for(self, end: int) -> bool:
        """Block the generator until `end` samples exist; False once closed short."""
        with self.condition:
            while self.audio.end < end and not self.closed:
                self.condition.wait(timeout=0.5)
            if self.audio.end < end:
                # Flush the tail once by padding the final chunk with silence;
                # chunks overlap, so padding again would never terminate.
                if self.closed and not self.flushed:
                    self.flushed = True
                    self.audio.append(self.np.zeros(end - self.audio.end, dtype=self.np.float32))
                    return True
                return False
            return True

    def _features(self):
        processor = self.engine.processor
        model = self.engine.model
        with self.condition:
            first_audio = self.audio.slice(0, self.first).copy()
        first = processor(
            first_audio, sampling_rate=SAMPLE_RATE, is_streaming=True,
            is_first_audio_chunk=True, language=self.language, return_tensors="pt",
        ).to(model.device, dtype=model.dtype)
        self.first_inputs = first
        yield first.input_features[:, : processor.num_mel_frames_first_audio_chunk, :]
        mel = processor.num_mel_frames_first_audio_chunk
        start = mel * self.hop - self.n_fft // 2
        while self._wait_for(start + self.per_chunk):
            with self.condition:
                audio = self.audio.slice(start, start + self.per_chunk).copy()
                # Retain the overlapping samples needed by the next window.
                next_start = (mel + processor.num_mel_frames_per_audio_chunk) * self.hop - self.n_fft // 2
                self.audio.discard_before(next_start)
            inputs = processor(
                audio, sampling_rate=SAMPLE_RATE,
                is_streaming=True, is_first_audio_chunk=False, language=self.language,
                return_tensors="pt",
            ).to(model.device, dtype=model.dtype)
            yield inputs.input_features
            mel += processor.num_mel_frames_per_audio_chunk
            start = mel * self.hop - self.n_fft // 2

    def start(self) -> None:
        from transformers import TextIteratorStreamer
        processor = self.engine.processor
        streamer = TextIteratorStreamer(processor.tokenizer, skip_special_tokens=True)
        features = self._features()
        first = next(features)

        def generate() -> None:
            try:
                import torch
                with torch.inference_mode():
                    self.engine.model.generate(
                        **{**self.first_inputs, "input_features": self._chain(first, features)},
                        streamer=streamer,
                    )
            except BaseException as exc:  # surfaced on the next request
                self.error = exc
                streamer.end()

        def read() -> None:
            for piece in streamer:
                with self.condition:
                    self.text.append(piece)

        self.thread = threading.Thread(target=generate, daemon=True)
        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()
        self.thread.start()

    @staticmethod
    def _chain(first, rest):
        yield first
        yield from rest

    def push(self, samples) -> None:
        with self.condition:
            if self.closed:
                raise RuntimeError("The live session is closed")
            if self.audio.size + len(samples) > 30 * SAMPLE_RATE:
                raise RuntimeError("Live recognition fell behind; finish from the full recording")
            self.audio.append(samples)
            self.condition.notify_all()
        if self.thread is None and self.audio.end >= self.first:
            self.start()

    def delta(self) -> str:
        if self.error is not None:
            raise RuntimeError("Streaming recognition failed") from self.error
        with self.condition:
            piece = "".join(self.text)
            self.text.clear()
            return piece

    def finish(self, timeout: float = 30.0) -> str:
        with self.condition:
            if self.audio.end and not self.closed:
                # Trailing silence gives the encoder the right context it needs to
                # emit the last word; also covers recordings shorter than one chunk.
                tail = max(self.first - self.audio.end, 0) + 2 * self.per_chunk
                self.audio.append(self.np.zeros(tail, dtype=self.np.float32))
                self.condition.notify_all()
        if self.thread is None and self.audio.end:
            self.start()
        with self.condition:
            self.closed = True
            self.condition.notify_all()
        deadline = time.monotonic() + timeout
        if self.thread is not None:
            self.thread.join(max(0.0, deadline - time.monotonic()))
        if self.reader is not None:
            self.reader.join(max(0.0, deadline - time.monotonic()))
        if any(thread is not None and thread.is_alive() for thread in (self.thread, self.reader)):
            raise RuntimeError("Live recognition did not stop; reload the speech worker before retrying")
        return self.delta()


class NemotronSpeech:
    def __init__(self) -> None:
        self.model = None
        self.processor = None
        self.device: str | None = None
        self.precision: str | None = None
        self.warmup = "not-started"
        self.session: StreamSession | None = None
        self.latency_ms: float | None = None

    def status(self) -> dict[str, Any]:
        status: dict[str, Any] = {
            "loaded": self.model is not None, "model": MODEL,
            "device": self.device if self.model is not None else None,
            "residency": "resident" if self.model is not None else "unloaded",
            "warmup": self.warmup,
        }
        if self.model is not None:
            status["speechExecution"] = {
                "modelId": "nemotron",
                "backendId": "transformers-cuda" if self.device == "cuda" else "transformers-cpu",
                "precision": self.precision,
                "checkpoint": {"repository": MODEL, "revision": MODEL_REVISION},
                "platform": sys.platform,
                "device": self.device,
            }
        return status

    def load(self, request: dict[str, Any]) -> dict[str, Any]:
        if self.model is not None:
            return self.status()
        import torch
        from verified_snapshot import verified_snapshot

        cache_root = request.get("cacheDir")
        emit_progress("Downloading the pinned Nemotron checkpoint…", stage="download")
        source = verified_snapshot(
            repo_id=MODEL, revision=MODEL_REVISION,
            cache_dir=str(Path(cache_root) / "hub") if cache_root else None,
            local_files_only=os.environ.get("HF_HUB_OFFLINE") == "1",
            allow_patterns=["*.json", "*.safetensors"],
        )
        cpu_only = request.get("device") == "cpu" or not torch.cuda.is_available()
        try:
            return self._load_on(source, torch, "cpu" if cpu_only else "cuda")
        except BaseException as exc:
            if cpu_only or "out of memory" not in str(exc).lower():
                raise
            # Another app holds the GPU; the 0.6B model runs fine on the CPU.
            self.unload()
            emit_progress("GPU memory is full — loading Nemotron on the CPU…", stage="load")
            return self._load_on(source, torch, "cpu")

    def _load_on(self, source, torch, device: str) -> dict[str, Any]:
        from transformers import AutoModelForRNNT, AutoProcessor
        emit_progress(f"Loading Nemotron weights on the {device.upper()}…", stage="load")
        cuda = device == "cuda"
        dtype = (torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16) if cuda else torch.float32
        try:
            self.processor = AutoProcessor.from_pretrained(source)
            self.processor.set_num_lookahead_tokens(LOOKAHEAD_TOKENS)
            self.latency_ms = float(getattr(self.processor, "streaming_latency_ms", 0) or 0) or None
            self.model = AutoModelForRNNT.from_pretrained(
                source, dtype=dtype, device_map={"": device},
            ).eval()
            self.device = device
            self.precision = {torch.bfloat16: "bf16", torch.float16: "fp16"}.get(dtype, "fp32")
            self.warmup = "warming"
            emit_progress("Warming up Nemotron speech inference…", stage="warmup")
            import numpy as np
            self._decode(np.zeros(SAMPLE_RATE, dtype=np.float32), "en-US")
            self.warmup = "complete"
            return self.status()
        except BaseException:
            self.unload()
            raise

    def _decode(self, samples, language: str) -> str:
        import torch
        inputs = self.processor(samples, sampling_rate=SAMPLE_RATE, language=language, return_tensors="pt")
        inputs = inputs.to(self.model.device, dtype=self.model.dtype)
        with torch.inference_mode():
            output = self.model.generate(**inputs, return_dict_in_generate=True)
        return str(self.processor.decode(output.sequences, skip_special_tokens=True)[0]).strip()

    def transcribe(self, request: dict[str, Any]) -> dict[str, Any]:
        if self.model is None:
            raise RuntimeError("No model is loaded")
        started = time.perf_counter()
        path = Path(str(request["audioPath"])).resolve()
        if not path.is_file():
            raise FileNotFoundError("The selected audio file no longer exists")
        samples = read_audio(path)
        if not len(samples):
            raise ValueError("The selected audio file contains no samples")
        code = str(request.get("language") or "en")
        inference_started = time.perf_counter()
        # Long imports are decoded in five-minute pieces to bound memory.
        window = 300 * SAMPLE_RATE
        pieces = [self._decode(samples[i : i + window], locale(code)) for i in range(0, len(samples), window)]
        finished = time.perf_counter()
        return {
            "text": " ".join(piece for piece in pieces if piece).strip(),
            "language": code, "requestedLanguage": code,
            "recognizedLanguage": code, "recognizedLanguages": [code], "languageStatus": "single",
            "duration": len(samples) / SAMPLE_RATE,
            "processingTime": finished - started,
            "inferenceTime": finished - inference_started,
            "timings": {
                "backendPreprocessingMs": (inference_started - started) * 1000,
                "inferenceMs": (finished - inference_started) * 1000,
            },
        }

    # Live typing ------------------------------------------------------------
    def stream_start(self, request: dict[str, Any]) -> dict[str, Any]:
        if self.model is None:
            raise RuntimeError("No model is loaded")
        if self.session is not None:
            self.session.finish(timeout=2)
        self.session = StreamSession(self, locale(str(request.get("language") or "en")))
        return {"started": True, "latencyMs": self.latency_ms}

    def stream_audio(self, samples) -> str:
        if self.session is None:
            raise RuntimeError("No live session is active")
        self.session.push(samples)
        return self.session.delta()

    def stream_finish(self) -> str:
        session, self.session = self.session, None
        return session.finish() if session is not None else ""

    def unload(self) -> dict[str, Any]:
        with contextlib.suppress(Exception):
            if self.session is not None:
                self.session.finish(timeout=2)
        self.session = None
        self.model = None
        self.processor = None
        self.device = None
        self.warmup = "not-started"
        gc.collect()
        torch = sys.modules.get("torch")
        if torch is not None:
            with contextlib.suppress(Exception):
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
        return self.status()
