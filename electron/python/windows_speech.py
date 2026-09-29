"""Native Windows CUDA R2T2 inference using Transformers, without vLLM.

The original R2T2 checkpoint is strictly converted in memory using the official
HuggingFace mappings. Native Windows hardware inference still needs validation.
"""
from __future__ import annotations

import contextlib
import gc
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

from worker_protocol import emit_progress

MODEL = "netease-youdao/Confucius4-R2T2"
MODEL_REVISION = "185ce639118ad1362d049ca0d8ed04b6ec5cd6c9"
SAMPLE_RATE = 16000
CONVERSION_VERSION = "transformers-5.15.0-v1"
CHUNK_SAMPLES = 30 * SAMPLE_RATE


class WindowsSpeech:
    def __init__(self):
        self.model = None
        self.processor = None
        self.cuda_preflight = None

    def status(self):
        return {"loaded": self.model is not None, "model": MODEL, "device": "cuda",
                **({"cudaPreflight": self.cuda_preflight}
                   if getattr(self, "cuda_preflight", None) is not None else {})}

    def load(self, request):
        if self.model is not None:
            return self.status()
        self.cuda_preflight = None
        import torch
        from cuda_preflight import ensure_cuda_compatible
        self.cuda_preflight = ensure_cuda_compatible(torch)
        from huggingface_hub import snapshot_download
        from huggingface_hub.constants import HF_HOME
        from accelerate import init_empty_weights
        from safetensors.torch import load_file
        from transformers import (AutoTokenizer, GenerationConfig, Qwen3ASRConfig,
                                  Qwen3ASRFeatureExtractor, Qwen3ASRForConditionalGeneration,
                                  Qwen3ASRProcessor)
        from windows_checkpoint import (ASR_CHAT_TEMPLATE, STATE_DICT_MAPPING_ASR,
                                        clean_config, convert_state_dict)

        cache_root = request.get("cacheDir")
        emit_progress("Downloading the pinned R2T2 checkpoint…", stage="download")
        source = Path(snapshot_download(
            repo_id=MODEL, revision=MODEL_REVISION,
            cache_dir=str(Path(cache_root) / "hub") if cache_root else None,
            local_files_only=os.environ.get("HF_HUB_OFFLINE") == "1",
            allow_patterns=["*.json", "*.safetensors", "*.model", "*.txt", "*.tiktoken"],
        ))
        converted_root = Path(cache_root or HF_HOME) / "delulu-r2t2-transformers" / CONVERSION_VERSION / MODEL_REVISION
        try:
            if (converted_root / "complete").is_file():
                self.processor = Qwen3ASRProcessor.from_pretrained(converted_root)
                dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
                self.model = Qwen3ASRForConditionalGeneration.from_pretrained(
                    converted_root, dtype=dtype, device_map={"": "cuda"},
                ).eval()
                self._warmup()
                return self.status()
            emit_progress("Converting R2T2 for native Windows CUDA (first load only)…", stage="conversion")
            self.processor = Qwen3ASRProcessor(
                feature_extractor=Qwen3ASRFeatureExtractor(),
                tokenizer=AutoTokenizer.from_pretrained(source), chat_template=ASR_CHAT_TEMPLATE,
            )
            config = Qwen3ASRConfig(**clean_config(source, "asr"))
            # Meta initialization avoids allocating another full random model.
            # Keep nonpersistent rotary/position buffers real while placing
            # parameters on meta; a blanket torch.device(meta) breaks .to(cuda).
            with init_empty_weights(include_buffers=False):
                self.model = Qwen3ASRForConditionalGeneration(config)
            shards = sorted(source.glob("model-*.safetensors"))
            if not shards:
                shards = [source / "model.safetensors"]
            state = {}
            for shard in shards:
                state.update(load_file(str(shard), device="cpu"))
            converted = convert_state_dict(state, STATE_DICT_MAPPING_ASR)
            # Safetensors removes tied aliases. R2T2 omits lm_head.weight,
            # which is the exact embedding tensor, not a separately trained head.
            if config.tie_word_embeddings and "lm_head.weight" not in converted:
                converted["lm_head.weight"] = converted["model.language_model.embed_tokens.weight"]
            self.model.load_state_dict(converted, strict=True, assign=True)
            del state, converted
            dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
            self.model.generation_config = GenerationConfig(
                eos_token_id=[151643, 151645], pad_token_id=151645, do_sample=False,
            )
            # Activate only complete conversions; interrupted writes are discarded.
            converted_root.parent.mkdir(parents=True, exist_ok=True)
            staged = Path(tempfile.mkdtemp(prefix="conversion-", dir=converted_root.parent))
            try:
                self.model.save_pretrained(staged)
                self.processor.save_pretrained(staged)
                (staged / "complete").write_text(MODEL + "@" + MODEL_REVISION, encoding="utf-8")
                os.replace(staged, converted_root)
            finally:
                if staged.exists():
                    shutil.rmtree(staged)
            # Cache the original BF16 weights before selecting this GPU's dtype.
            self.model.to(device="cuda", dtype=dtype).eval()
            self._warmup()
            return self.status()
        except BaseException:
            self.unload()
            raise

    def _warmup(self):
        import numpy as np
        # Full decoder warmup must succeed before Ready; its result is private.
        self._generate(np.zeros(SAMPLE_RATE, dtype=np.float32), "English", 8)

    def _generate(self, samples, language, max_tokens):
        import torch
        inputs = self.processor.apply_transcription_request(
            audio=samples, language=language, return_tensors="pt",
            processor_kwargs={"audio_kwargs": {"sampling_rate": SAMPLE_RATE}},
        ).to(self.model.device).to(self.model.dtype)
        length = int(inputs["input_ids"].shape[-1])
        with torch.inference_mode():
            generated = self.model.generate(**inputs, max_new_tokens=max_tokens, do_sample=False)
        output = generated[0][length:]
        if max_tokens > 8 and len(output) >= max_tokens and int(output[-1]) not in (151643, 151645):
            raise RuntimeError("R2T2 reached its transcription token limit. Try a shorter audio segment.")
        parsed = self.processor.decode(
            output, skip_special_tokens=True, return_format="parsed",
        )
        if not isinstance(parsed, dict) or not isinstance(parsed.get("transcription"), str):
            raise RuntimeError("R2T2 returned an invalid transcription response")
        return parsed

    def transcribe(self, request):
        if self.model is None:
            raise RuntimeError("R2T2 is not loaded. Load the model to try again.")
        audio = Path(request["audioPath"])
        if not audio.is_file():
            raise FileNotFoundError("The selected audio file no longer exists")
        from transcription_engine import LANGUAGE_NAMES, recognized_language_metadata
        import soundfile as sf
        started = time.perf_counter()
        try:
            samples, rate = sf.read(str(audio), dtype="float32", always_2d=False)
        except RuntimeError:
            import librosa
            samples, rate = librosa.load(str(audio), sr=SAMPLE_RATE, mono=True)
        if samples.ndim > 1:
            samples = samples.mean(axis=1)
        if rate != SAMPLE_RATE:
            import soxr
            samples = soxr.resample(samples, rate, SAMPLE_RATE)
        if not len(samples):
            raise ValueError("The selected audio file contains no samples")
        code = str(request.get("language", "en")).lower()
        language = LANGUAGE_NAMES.get(code)
        inference_started = time.perf_counter()
        results = []
        try:
            for offset in range(0, len(samples), CHUNK_SAMPLES):
                results.append(self._generate(samples[offset:offset + CHUNK_SAMPLES], language, 4096))
        except BaseException:
            with contextlib.suppress(Exception):
                torch = sys.modules.get("torch")
                if torch is not None:
                    torch.cuda.empty_cache()
            raise
        finished = time.perf_counter()
        # These are labels from the parsed model output, not a separate detector;
        # a forced prompt can influence them. Never substitute the prompt hint.
        language_metadata = recognized_language_metadata([result.get("language") for result in results])
        return {"text": " ".join(result["transcription"].strip() for result in results).strip(),
                "language": language_metadata["recognizedLanguage"] or "und",
                "requestedLanguage": code,
                **language_metadata,
                "duration": len(samples) / SAMPLE_RATE,
                "processingTime": finished - started,
                "inferenceTime": finished - inference_started}

    def unload(self):
        self.model = None
        self.processor = None
        self.cuda_preflight = None
        gc.collect()
        torch = sys.modules.get("torch")
        with contextlib.suppress(Exception):
            if torch is not None and torch.cuda.is_available():
                torch.cuda.empty_cache()
        return {"loaded": False}
