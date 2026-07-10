#!/usr/bin/env python3
"""Local transcription adapter for Delulu Talks' four specialized engines."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, asdict
from typing import Any


MOSS = "OpenMOSS-Team/MOSS-Transcribe-Diarize"
COHERE = "CohereLabs/cohere-transcribe-03-2026"
NEMOTRON = "nvidia/nemotron-3.5-asr-streaming-0.6b"
PARAKEET = "nvidia/parakeet-tdt-0.6b-v3"
PARAKEET_GGUF_REPO = "handy-computer/parakeet-tdt-0.6b-v3-gguf"
PARAKEET_GGUF_FILE = "parakeet-tdt-0.6b-v3-Q8_0.gguf"
PARAKEET_LANGUAGES = {
    "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it",
    "lv", "lt", "mt", "pl", "pt", "ro", "ru", "sk", "sl", "es", "sv", "uk",
}
SUPPORTED_MODELS = {MOSS, COHERE, NEMOTRON, PARAKEET}
_parakeet_model: Any | None = None


@dataclass
class Segment:
    start: float
    end: float
    speaker: str
    text: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe speech with a local Hugging Face model")
    parser.add_argument("--audio")
    parser.add_argument("--model", choices=sorted(SUPPORTED_MODELS))
    parser.add_argument("--language", default="auto")
    parser.add_argument("--output-style", default="smart", choices=["smart", "plain", "speaker-aware"])
    parser.add_argument("--vocabulary-json", default="[]")
    parser.add_argument("--punctuation", action="store_true")
    parser.add_argument("--warmup", action="store_true")
    parser.add_argument("--serve", action="store_true")
    args = parser.parse_args()
    if not args.model:
        parser.error("--model is required")
    if not args.serve and not args.warmup and not args.audio:
        parser.error("--audio is required unless --warmup is used")
    return args


def load_runtime() -> tuple[Any, Any]:
    try:
        import torch
        import transformers
        return torch, transformers
    except Exception as exc:
        raise RuntimeError(
            "The local ASR environment is incomplete. Run model setup from Delulu Talks."
        ) from exc


def device_and_dtype(torch: Any) -> tuple[Any, Any]:
    device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
    dtype = torch.bfloat16 if device.type == "cuda" else torch.float32
    return device, dtype


def normalize_recorded_wav(audio_path: str) -> tuple[str, str | None]:
    """Convert captured device WAVs to the 16kHz mono format expected by ASR.

    CPAL records in the microphone's native format (commonly 44.1kHz stereo).
    MOSS's audio loader can reject those files despite the WAV being valid, so
    normalize microphone captures before any model sees them. Other file types
    retain their original loader path.
    """
    if not audio_path.lower().endswith(".wav"):
        return audio_path, None

    try:
        import librosa
        import soundfile as sf

        samples, sample_rate = sf.read(audio_path, dtype="float32", always_2d=True)
    except Exception as exc:
        raise RuntimeError(f"Unable to read captured WAV audio: {exc}") from exc

    if samples.shape[0] == 0:
        # An interrupted recorder can leave the RIFF data-size field at zero
        # even though the PCM payload is present. FFmpeg can safely recover it.
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise RuntimeError(
                "Captured WAV has an unfinished header and FFmpeg is unavailable for recovery."
            )

        with tempfile.NamedTemporaryFile(prefix="delulu-recovered-", suffix=".wav", delete=False) as handle:
            normalized_path = handle.name

        try:
            subprocess.run(
                [ffmpeg, "-y", "-v", "error", "-i", audio_path, "-ac", "1", "-ar", "16000", normalized_path],
                check=True,
                capture_output=True,
                text=True,
            )
        except subprocess.CalledProcessError as exc:
            os.unlink(normalized_path)
            raise RuntimeError(f"Unable to recover captured WAV: {exc.stderr.strip()}") from exc

        return normalized_path, normalized_path

    mono = samples.mean(axis=1)
    if sample_rate != 16_000:
        mono = librosa.resample(mono, orig_sr=sample_rate, target_sr=16_000)

    if sample_rate == 16_000 and samples.shape[1] == 1:
        return audio_path, None

    with tempfile.NamedTemporaryFile(prefix="delulu-", suffix=".wav", delete=False) as handle:
        normalized_path = handle.name

    try:
        sf.write(normalized_path, mono, 16_000, subtype="PCM_16")
    except Exception:
        os.unlink(normalized_path)
        raise

    return normalized_path, normalized_path


def active_vocabulary(raw: str) -> list[dict[str, Any]]:
    try:
        values = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid custom vocabulary: {exc}") from exc
    return [entry for entry in values if entry.get("enabled", True) and entry.get("term", "").strip()]


def apply_vocabulary(text: str, vocabulary: list[dict[str, Any]]) -> str:
    """Replace explicit aliases only; whole phrase matching avoids collateral edits."""
    rules: dict[str, str] = {}
    for entry in vocabulary:
        term = entry["term"].strip()
        replacement = entry.get("replacement", "").strip() or term
        aliases = [part.strip() for part in entry.get("soundsLike", "").split(",")]
        rules.update((alias.casefold(), replacement) for alias in aliases if alias)
        if replacement != term:
            rules[term.casefold()] = replacement

    if not rules:
        return text.strip()

    sources = sorted(rules, key=len, reverse=True)
    pattern = re.compile(
        rf"(?<!\w)(?:{'|'.join(re.escape(source) for source in sources)})(?!\w)",
        re.IGNORECASE,
    )
    return pattern.sub(lambda match: rules[match.group(0).casefold()], text).strip()


def hotword_prompt(vocabulary: list[dict[str, Any]]) -> str:
    default = (
        "请将音频转写为文本，每一段需以起始时间戳和说话人编号"
        "（[S01]、[S02]、[S03]…）开头，正文为对应的语音内容，"
        "并在段末标注结束时间戳，以清晰标明该段语音范围。"
    )
    terms = [entry["term"].strip() for entry in vocabulary]
    return f"{default} 热词提示：{', '.join(terms)}" if terms else default


def transcribe_moss(torch: Any, transformers: Any, args: argparse.Namespace, vocabulary: list[dict[str, Any]]) -> tuple[str, list[Segment], str]:
    try:
        from moss_transcribe_diarize import parse_transcript
        from moss_transcribe_diarize.inference_utils import (
            build_transcription_messages,
            generate_transcription,
        )
    except ImportError as exc:
        raise RuntimeError("MOSS helpers are missing; rebuild the selected model environment") from exc

    device, dtype = device_and_dtype(torch)
    model = transformers.AutoModelForCausalLM.from_pretrained(
        MOSS, trust_remote_code=True, dtype="auto"
    ).to(dtype=dtype).to(device).eval()
    processor = transformers.AutoProcessor.from_pretrained(MOSS, trust_remote_code=True)
    if args.warmup:
        return "", [], args.language

    messages = build_transcription_messages(args.audio, prompt=hotword_prompt(vocabulary))
    result = generate_transcription(
        model, processor, messages, max_new_tokens=8192, do_sample=False,
        device=device, dtype=dtype,
    )
    raw = str(result["text"]).strip()
    parsed = parse_transcript(raw)
    segments = [Segment(float(item.start), float(item.end), str(item.speaker), str(item.text).strip()) for item in parsed]
    return raw, segments, args.language


def transcribe_cohere(torch: Any, transformers: Any, args: argparse.Namespace) -> tuple[str, list[Segment], str]:
    from transformers.audio_utils import load_audio

    language = "en" if args.language == "auto" else args.language
    processor = transformers.AutoProcessor.from_pretrained(COHERE, trust_remote_code=True)
    # The checkpoint ships a custom Conformer implementation. Instantiating
    # Transformers' similarly named built-in class bypasses that implementation
    # and is incompatible with the processor's `length` input. The July 2026
    # checkpoint also declares its ignored load keys as a list while current
    # Transformers expects a set, so normalize that class attribute before
    # `from_pretrained` finalizes model loading.
    from transformers.dynamic_module_utils import get_class_from_dynamic_module

    model_class = get_class_from_dynamic_module(
        "modeling_cohere_asr.CohereAsrForConditionalGeneration", COHERE
    )
    from transformers.generation import GenerationMixin

    if not issubclass(model_class, GenerationMixin):
        model_class = type(
            "CompatibleCohereAsrForConditionalGeneration",
            (model_class, GenerationMixin),
            {},
        )
    ignored_keys = getattr(model_class, "_keys_to_ignore_on_load_unexpected", None)
    if isinstance(ignored_keys, list):
        model_class._keys_to_ignore_on_load_unexpected = set(ignored_keys)
    model = model_class.from_pretrained(
        COHERE, device_map="auto", trust_remote_code=True
    )
    if args.warmup:
        return "", [], language

    audio = load_audio(args.audio, sampling_rate=16000)
    inputs = processor(audio, sampling_rate=16000, return_tensors="pt", language=language, punctuation=args.punctuation)
    chunk_index = inputs.get("audio_chunk_index")
    inputs.to(model.device, dtype=model.dtype)
    outputs = model.generate(**inputs, max_new_tokens=512)
    decoded = processor.decode(outputs, skip_special_tokens=True, audio_chunk_index=chunk_index, language=language)
    raw = decoded[0] if isinstance(decoded, list) else decoded
    return str(raw).strip(), [], language


def transcribe_nemotron(torch: Any, transformers: Any, args: argparse.Namespace) -> tuple[str, list[Segment], str]:
    device = 0 if torch.cuda.is_available() else -1
    pipe = transformers.pipeline(
        "automatic-speech-recognition", model=NEMOTRON, device=device,
        dtype=torch.float16 if device == 0 else torch.float32,
    )
    if args.warmup:
        return "", [], args.language
    result = pipe(args.audio)
    raw = result.get("text", "") if isinstance(result, dict) else str(result)
    return str(raw).strip(), [], args.language


def parakeet_model() -> Any:
    global _parakeet_model
    if _parakeet_model is not None:
        return _parakeet_model

    try:
        import transcribe_cpp
        from huggingface_hub import hf_hub_download
    except ImportError as exc:
        raise RuntimeError("Parakeet's transcribe.cpp runtime is missing; rebuild the selected model environment") from exc

    model_path = hf_hub_download(repo_id=PARAKEET_GGUF_REPO, filename=PARAKEET_GGUF_FILE)
    devices = transcribe_cpp.backends()
    nvidia = next(
        (device for device in devices if device.kind == "vulkan" and "nvidia" in device.description.casefold()),
        None,
    )
    backend = "vulkan" if nvidia else "auto"
    gpu_device = nvidia.index if nvidia else 0
    _parakeet_model = transcribe_cpp.Model(model_path, backend=backend, gpu_device=gpu_device)
    return _parakeet_model


def transcribe_parakeet(args: argparse.Namespace) -> tuple[str, list[Segment], str]:
    model = parakeet_model()

    if args.warmup:
        # Loading the GGUF does not compile/initialize every Vulkan kernel.
        # Run a short silent request while the app starts so the first real
        # dictation does not pay that one-time GPU cost after key release.
        import numpy as np

        language_hint = args.language if args.language in PARAKEET_LANGUAGES else None
        with model.session() as session:
            session.run(
                np.zeros(80_000, dtype=np.float32),
                language=language_hint,
                timestamps="segment",
            )
        return "", [], args.language

    import soundfile as sf

    samples, sample_rate = sf.read(args.audio, dtype="float32", always_2d=True)
    if sample_rate != 16_000:
        raise RuntimeError(f"Parakeet expected 16 kHz audio, received {sample_rate} Hz")
    mono = samples.mean(axis=1)
    language_hint = args.language if args.language in PARAKEET_LANGUAGES else None

    with model.session() as session:
        result = session.run(mono, language=language_hint, timestamps="segment")

    segments = [
        Segment(item.t0_ms / 1000.0, item.t1_ms / 1000.0, "", item.text.strip())
        for item in result.segments
    ]
    language = language_hint or result.language or "auto"
    return result.text.strip(), segments, language


def format_output(raw: str, segments: list[Segment], style: str) -> str:
    plain = " ".join(segment.text for segment in segments).strip() if segments else raw
    speakers = {segment.speaker for segment in segments}
    speaker_aware = style == "speaker-aware" or (style == "smart" and len(speakers) > 1)
    if not speaker_aware or not segments:
        return plain

    def stamp(seconds: float) -> str:
        minutes, remaining = divmod(max(0, int(seconds)), 60)
        return f"{minutes:02d}:{remaining:02d}"

    return "\n".join(f"[{stamp(segment.start)}] {segment.speaker}: {segment.text}" for segment in segments)


def run_transcription(args: argparse.Namespace) -> dict[str, Any]:
    vocabulary = active_vocabulary(args.vocabulary_json)
    temporary_audio: str | None = None
    try:
        if not args.warmup:
            args.audio, temporary_audio = normalize_recorded_wav(args.audio)

        if args.model == PARAKEET:
            raw, segments, language = transcribe_parakeet(args)
        else:
            torch, transformers = load_runtime()
            if args.model == MOSS:
                raw, segments, language = transcribe_moss(torch, transformers, args, vocabulary)
            elif args.model == COHERE:
                raw, segments, language = transcribe_cohere(torch, transformers, args)
            else:
                raw, segments, language = transcribe_nemotron(torch, transformers, args)

        if args.warmup:
            return {"ready": True}

        text = apply_vocabulary(format_output(raw, segments, args.output_style), vocabulary)
        if not args.punctuation:
            text = re.sub(r"[^\w\s'-]", "", text, flags=re.UNICODE).lower().strip()
        return {
            "text": text,
            "rawText": raw,
            "language": language,
            "segments": [asdict(segment) for segment in segments],
        }
    finally:
        if temporary_audio:
            try:
                os.unlink(temporary_audio)
            except FileNotFoundError:
                pass


def serve(args: argparse.Namespace) -> int:
    try:
        warmup_args = argparse.Namespace(**vars(args))
        warmup_args.warmup = True
        run_transcription(warmup_args)

        # Pay import and resampler initialization costs before the first
        # recording. Microphones commonly capture at 48 kHz while Parakeet
        # expects 16 kHz; warming the exact conversion path keeps the first
        # dictation as responsive as every subsequent one.
        import librosa
        import numpy as np
        import soundfile  # noqa: F401

        librosa.resample(
            np.zeros(240_000, dtype=np.float32),
            orig_sr=48_000,
            target_sr=16_000,
        )
        print(json.dumps({"ready": True}), flush=True)
    except Exception as exc:
        print(json.dumps({"error": f"Sidecar warmup failed: {exc}"}), flush=True)
        return 3

    for line in sys.stdin:
        try:
            request = json.loads(line)
            request_args = argparse.Namespace(
                audio=request["audio"],
                model=request.get("model", args.model),
                language=request.get("language", "auto"),
                output_style=request.get("outputStyle", "smart"),
                vocabulary_json=json.dumps(request.get("customWords", [])),
                punctuation=bool(request.get("punctuation", True)),
                warmup=False,
                serve=False,
            )
            payload = run_transcription(request_args)
            print(json.dumps(payload, ensure_ascii=False), flush=True)
        except Exception as exc:
            print(json.dumps({"error": f"Transcription failed: {exc}"}), flush=True)

    return 0


def main() -> int:
    args = parse_args()
    if args.serve:
        return serve(args)

    try:
        payload = run_transcription(args)
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(f"Transcription failed: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
