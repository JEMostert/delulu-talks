#!/usr/bin/env python3
"""Persistent JSON-lines worker for Delulu Talks and CrisperWhisper 2.0.

The process deliberately keeps one model resident between requests. Protocol
messages are prefixed so library progress output can never be mistaken for a
response by Electron.
"""

from __future__ import annotations

import contextlib
import gc
import json
import os
import re
import sys
import time
import traceback
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any


PROTOCOL_PREFIX = "@delulu:"
MODEL_NAMES = {"small", "medium", "turbo", "large"}


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(PROTOCOL_PREFIX + json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def active_vocabulary(values: Any) -> list[dict[str, Any]]:
    if not isinstance(values, list):
        return []
    output: list[dict[str, Any]] = []
    for value in values[:500]:
        if not isinstance(value, dict) or not value.get("enabled", True):
            continue
        term = str(value.get("term", "")).strip()
        if not term:
            continue
        output.append({
            "term": term[:256],
            "soundsLike": str(value.get("soundsLike", ""))[:1024],
            "replacement": str(value.get("replacement", ""))[:4096],
            "enabled": True,
        })
    return output


def replacement_rules(vocabulary: list[dict[str, Any]]) -> dict[str, str]:
    rules: dict[str, str] = {}
    for entry in vocabulary:
        term = entry["term"].strip()
        replacement = entry.get("replacement", "").strip() or term
        aliases = [value.strip() for value in entry.get("soundsLike", "").split(",")]
        for alias in aliases:
            if alias:
                rules[alias.casefold()] = replacement
        if replacement != term:
            rules[term.casefold()] = replacement
    return rules


def apply_vocabulary(text: str, vocabulary: list[dict[str, Any]]) -> str:
    rules = replacement_rules(vocabulary)
    if not rules:
        return text.strip()
    sources = sorted(rules, key=len, reverse=True)
    pattern = re.compile(
        rf"(?<!\w)(?:{'|'.join(re.escape(source) for source in sources)})(?!\w)",
        re.IGNORECASE,
    )
    return pattern.sub(lambda match: rules[match.group(0).casefold()], text).strip()


def word_payload(word: Any) -> dict[str, Any]:
    if is_dataclass(word):
        value = asdict(word)
    elif isinstance(word, dict):
        value = word
    else:
        value = {
            "word": getattr(word, "word", ""),
            "start": getattr(word, "start", 0.0),
            "end": getattr(word, "end", 0.0),
        }
    return {
        "word": str(value.get("word", "")),
        "start": round(float(value.get("start", 0.0)), 3),
        "end": round(float(value.get("end", 0.0)), 3),
    }


def result_payload(result: Any, vocabulary: list[dict[str, Any]]) -> dict[str, Any]:
    words = getattr(result, "words", None) or []
    return {
        "text": apply_vocabulary(str(getattr(result, "text", "")), vocabulary),
        "language": str(getattr(result, "language", "en")),
        "duration": float(getattr(result, "duration", 0.0) or 0.0),
        "processingTime": float(getattr(result, "processing_time", 0.0) or 0.0),
        "words": [word_payload(word) for word in words],
    }


class Worker:
    def __init__(self) -> None:
        self.model: Any | None = None
        self.model_name: str | None = None
        self.backend: str | None = None
        self.compute_type: str | None = None
        self.device: str | None = None

    @staticmethod
    def resolve_runtime(backend: str, compute_type: str) -> tuple[str, str, str]:
        import importlib.util

        chosen_backend = backend
        if chosen_backend == "auto":
            chosen_backend = "ct2" if importlib.util.find_spec("ctranslate2") else "transformers"

        if chosen_backend == "ct2":
            import ctranslate2

            has_cuda = ctranslate2.get_cuda_device_count() > 0
            chosen_device = "cuda" if has_cuda else "cpu"
            chosen_compute = compute_type
            if chosen_compute == "auto":
                chosen_compute = "float16" if has_cuda else "int8"
        else:
            import torch

            has_cuda = torch.cuda.is_available()
            has_mps = bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available())
            chosen_device = "cuda" if has_cuda else "mps" if has_mps else "cpu"
            chosen_compute = compute_type
            if chosen_compute == "auto":
                chosen_compute = "float16" if has_cuda or has_mps else "float32"
            if chosen_compute in {"int8", "int8_float16"}:
                chosen_compute = "float16" if has_cuda or has_mps else "float32"

        return chosen_backend, chosen_compute, chosen_device

    def unload(self) -> dict[str, Any]:
        self.model = None
        self.model_name = None
        self.backend = None
        self.compute_type = None
        self.device = None
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        return {"loaded": False}

    def load(self, request: dict[str, Any]) -> dict[str, Any]:
        model_name = str(request.get("model", "medium"))
        if model_name not in MODEL_NAMES:
            raise ValueError(f"Unsupported CrisperWhisper model: {model_name}")
        requested_backend = str(request.get("backend", "auto"))
        requested_compute = str(request.get("computeType", "auto")).replace("int8Float16", "int8_float16")
        backend, compute_type, device = self.resolve_runtime(requested_backend, requested_compute)
        draft_model = "turbo" if request.get("speculativeDecoding") and model_name == "large" and backend == "ct2" else None

        signature = (model_name, backend, compute_type, device, draft_model)
        current = (self.model_name, self.backend, self.compute_type, self.device, getattr(self, "draft_model", None))
        if self.model is not None and current == signature:
            return self.status()

        self.unload()
        from crisperwhisper import CrisperWhisperModel

        cache_dir = request.get("cacheDir")
        kwargs: dict[str, Any] = {
            "backend": backend,
            "compute_type": compute_type,
            "device": device,
        }
        if cache_dir:
            kwargs["cache_dir"] = str(cache_dir)
        if draft_model:
            kwargs["draft_model"] = draft_model
            kwargs["speculative_k"] = "auto"

        self.model = CrisperWhisperModel(model_name, **kwargs)
        self.model_name = model_name
        self.backend = backend
        self.compute_type = compute_type
        self.device = device
        self.draft_model = draft_model
        return self.status()

    def status(self) -> dict[str, Any]:
        return {
            "loaded": self.model is not None,
            "model": self.model_name,
            "backend": self.backend,
            "computeType": self.compute_type,
            "device": self.device,
            "draftModel": getattr(self, "draft_model", None),
        }

    def ensure_loaded(self) -> Any:
        if self.model is None:
            raise RuntimeError("No model is loaded")
        return self.model

    @staticmethod
    def transcription_kwargs(request: dict[str, Any]) -> dict[str, Any]:
        return {
            "language": str(request.get("language", "en")),
            "word_timestamps": bool(request.get("wordTimestamps", True)),
            "hallucination_mitigation": True,
            "temperature_fallback": True,
            "longform_strategy": "continuation",
        }

    def transcribe(self, request: dict[str, Any]) -> dict[str, Any]:
        model = self.ensure_loaded()
        audio = str(Path(str(request["audioPath"])).resolve())
        if not Path(audio).is_file():
            raise FileNotFoundError("The selected audio file no longer exists")
        mode = str(request.get("mode", "dual"))
        vocabulary = active_vocabulary(request.get("customWords"))
        kwargs = self.transcription_kwargs(request)
        speculative = bool(request.get("speculativeDecoding")) and self.backend == "ct2" and self.model_name == "large"

        started = time.perf_counter()
        intended: dict[str, Any] | None = None
        verbatim: dict[str, Any] | None = None

        if mode == "dual":
            if self.backend == "ct2":
                first, second = model.transcribe_dual(audio, modes=("verbatim", "intended"), **kwargs)
                verbatim = result_payload(first, vocabulary)
                intended = result_payload(second, vocabulary)
            else:
                verbatim = result_payload(model.transcribe(audio, mode="verbatim", **kwargs), vocabulary)
                intended = result_payload(model.transcribe(audio, mode="intended", **kwargs), vocabulary)
        elif mode == "verbatim":
            verbatim = result_payload(
                model.transcribe(audio, mode="verbatim", speculative_decoding=speculative, **kwargs),
                vocabulary,
            )
        elif mode == "intended":
            intended = result_payload(
                model.transcribe(audio, mode="intended", speculative_decoding=speculative, **kwargs),
                vocabulary,
            )
        else:
            raise ValueError(f"Unsupported transcription mode: {mode}")

        primary = intended or verbatim or {}
        return {
            "mode": mode,
            "text": primary.get("text", ""),
            "intendedText": intended.get("text", "") if intended else "",
            "verbatimText": verbatim.get("text", "") if verbatim else "",
            "language": primary.get("language", request.get("language", "en")),
            "duration": max((intended or {}).get("duration", 0), (verbatim or {}).get("duration", 0)),
            "processingTime": time.perf_counter() - started,
            "words": intended.get("words", []) if intended else verbatim.get("words", []) if verbatim else [],
            "verbatimWords": verbatim.get("words", []) if verbatim else [],
        }

    def forced_align(self, request: dict[str, Any]) -> dict[str, Any]:
        model = self.ensure_loaded()
        reference = str(request.get("referenceText", "")).strip()
        if not reference:
            raise ValueError("A reference transcript is required for forced alignment")
        started = time.perf_counter()
        result = model.forced_align(
            str(Path(str(request["audioPath"])).resolve()),
            reference,
            language=str(request.get("language", "en")),
            mode="verbatim",
        )
        payload = result_payload(result, [])
        return {
            "mode": "forcedAlign",
            "text": reference,
            "intendedText": reference,
            "verbatimText": "",
            "language": payload["language"],
            "duration": payload["duration"],
            "processingTime": time.perf_counter() - started,
            "words": payload["words"],
            "verbatimWords": [],
        }

    def verbatimize(self, request: dict[str, Any]) -> dict[str, Any]:
        model = self.ensure_loaded()
        reference = str(request.get("referenceText", "")).strip()
        if not reference:
            raise ValueError("A clean reference transcript is required for Verbatimize")
        started = time.perf_counter()
        result = model.verbatimize(
            str(Path(str(request["audioPath"])).resolve()),
            transcript=reference,
            language=str(request.get("language", "en")),
            word_timestamps=bool(request.get("wordTimestamps", True)),
        )
        payload = result_payload(result, active_vocabulary(request.get("customWords")))
        return {
            "mode": "verbatimize",
            "text": payload["text"],
            "intendedText": reference,
            "verbatimText": payload["text"],
            "language": payload["language"],
            "duration": payload["duration"],
            "processingTime": time.perf_counter() - started,
            "words": payload["words"],
            "verbatimWords": payload["words"],
        }

    def dispatch(self, request: dict[str, Any]) -> Any:
        command = request.get("command")
        if command == "ping":
            return {"python": sys.version.split()[0], **self.status()}
        if command == "load":
            return self.load(request)
        if command == "unload":
            return self.unload()
        if command == "status":
            return self.status()
        if command == "transcribe":
            return self.transcribe(request)
        if command == "forcedAlign":
            return self.forced_align(request)
        if command == "verbatimize":
            return self.verbatimize(request)
        if command == "shutdown":
            self.unload()
            return {"shutdown": True}
        raise ValueError(f"Unknown worker command: {command}")


def main() -> int:
    worker = Worker()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id: Any = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            with contextlib.redirect_stdout(sys.stderr):
                result = worker.dispatch(request)
            emit({"id": request_id, "ok": True, "result": result})
            if request.get("command") == "shutdown":
                return 0
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            emit({"id": request_id, "ok": False, "error": str(exc)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
