"""Opt-in installed audio decoder contracts, with inference replaced at its seam.

No model loading, downloads, GPU calls, or personal audio. Run using a prepared
speech runtime's Python. The decoder libraries and adapter decode path are real;
the inference callback only records the PCM handed to recognition.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import sys
import tempfile
import types
from pathlib import Path

RATE = 16000
DURATION = 0.5


def make_probe(backend):
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root / "electron/python"))
    captured = []
    if backend == "mlx":
        if sys.platform != "darwin" or platform.machine() != "arm64":
            raise RuntimeError("The MLX decoder contract requires Apple Silicon")
        from metal_speech import MetalSpeech
        engine = MetalSpeech()
        def generate(samples, **kwargs):
            captured.append(samples)
            return types.SimpleNamespace(text="decoder probe", language=["English"])
        engine.model = types.SimpleNamespace(generate=generate)
    elif backend == "windows":
        from windows_speech import WindowsSpeech
        engine = WindowsSpeech()
        engine.model = object()
        def generate(samples, language, limit):
            captured.append(samples)
            return {"transcription": "decoder probe", "language": "English"}
        engine._generate = generate
    else:
        from transcription_engine import Worker
        # Select the Linux buffered adapter without altering platform globals.
        # Constructor backend routing is unrelated to these decoder contracts.
        engine = Worker.__new__(Worker)
        engine.speech = None
        def transcribe(**kwargs):
            samples, rate = kwargs["audio"][0]
            if rate != RATE:
                raise AssertionError("Recognition received a wrong declared sample rate")
            captured.append(samples)
            return [types.SimpleNamespace(text="decoder probe")]
        engine.model = types.SimpleNamespace(transcribe=transcribe)
    return engine, captured


def assert_pcm(samples, expected, np):
    pcm = np.asarray(samples)
    if pcm.ndim != 1 or len(pcm) != len(expected):
        raise AssertionError(f"Expected {len(expected)} mono samples, got shape {pcm.shape}")
    if pcm.dtype != np.float32 or not np.isfinite(pcm).all():
        raise AssertionError("Recognition must receive finite float32 PCM")
    # Ignore filter boundary transients; interior values expose wrong stereo
    # mixing, wrong rate conversion, duplicated channels and silent decodes.
    margin = int(0.02 * RATE)
    error = float(np.max(np.abs(pcm[margin:-margin] - expected[margin:-margin])))
    if error > 0.003:
        raise AssertionError(f"Decoded waveform differs from expected mono signal ({error:.6f})")


def run_contracts(backend):
    import numpy as np
    import soundfile as sf
    if backend != "mlx":
        # Fail explicitly for missing installed fallback/resampler dependencies.
        import librosa  # noqa: F401
        import soxr  # noqa: F401
    engine, captured = make_probe(backend)
    expected_time = np.arange(int(RATE * DURATION)) / RATE
    expected = (0.15 * np.sin(2 * np.pi * 440 * expected_time)).astype(np.float32)
    cases = []
    with tempfile.TemporaryDirectory(prefix="delulu-decoder-contract-") as temporary:
        directory = Path(temporary)
        fixtures = [
            ("mono-wav", 16000, 1, "WAV", "PCM_16"),
            ("stereo-wav", 16000, 2, "WAV", "PCM_16"),
            ("resample-44100", 44100, 1, "WAV", "PCM_16"),
            ("stereo-resample-48000", 48000, 2, "WAV", "PCM_16"),
            ("resample-11025", 11025, 1, "WAV", "PCM_16"),
            ("compressed-flac", 44100, 2, "FLAC", "PCM_16"),
            ("compressed-ogg", 48000, 2, "OGG", "VORBIS"),
        ]
        for name, rate, channels, format_name, subtype in fixtures:
            # Exactly half a second except odd sample rates: preserve integer
            # frame rounding and compare actual resampled length accordingly.
            time = np.arange(round(rate * DURATION)) / rate
            signal = np.sin(2 * np.pi * 440 * time)
            data = (0.15 * signal).astype(np.float32)
            if channels == 2:
                data = np.column_stack((0.25 * signal, 0.05 * signal)).astype(np.float32)
            path = directory / f"{name}.{format_name.lower()}"
            sf.write(path, data, rate, format=format_name, subtype=subtype)
            before = hashlib.sha256(path.read_bytes()).hexdigest()
            captured.clear()
            result = engine.transcribe({"audioPath": str(path), "language": "en"})
            if len(captured) != 1:
                raise AssertionError(f"{name}: expected one recognition call, got {len(captured)}")
            samples = np.asarray(captured[0])
            # Resampling length may round one frame either way at odd rates.
            if abs(len(samples) - len(expected)) > 1:
                raise AssertionError(f"{name}: resampling produced {len(samples)} samples")
            target = (0.15 * np.sin(2 * np.pi * 440 * np.arange(len(samples)) / RATE)).astype(np.float32)
            assert_pcm(samples, target, np)
            if abs(result["duration"] - len(samples) / RATE) > 1e-9:
                raise AssertionError(f"{name}: incorrect reported duration")
            if hashlib.sha256(path.read_bytes()).hexdigest() != before:
                raise AssertionError(f"{name}: source file changed")
            cases.append({"name": name, "samples": len(samples), "status": "passed"})
        for name in ("invalid-audio", "empty-wav", "missing-file"):
            path = directory / f"{name}.wav"
            if name == "invalid-audio":
                path.write_bytes(b"This is deliberately not an audio container.")
            elif name == "empty-wav":
                sf.write(path, np.empty(0, dtype=np.float32), RATE, format="WAV")
            before = path.read_bytes() if path.exists() else None
            captured.clear()
            try:
                engine.transcribe({"audioPath": str(path), "language": "en"})
            except (ImportError, AssertionError):
                raise
            except Exception as error:
                if name == "missing-file" and not isinstance(error, FileNotFoundError):
                    raise
                if name == "empty-wav" and not isinstance(error, ValueError):
                    raise
                if name == "invalid-audio" and not (
                    isinstance(error, (RuntimeError, ValueError, OSError))
                    or type(error).__module__.startswith("audioread")
                ):
                    raise
                if captured:
                    raise AssertionError(f"{name}: invalid input reached recognition") from error
                cases.append({"name": name, "status": "passed", "errorType": type(error).__name__})
            else:
                raise AssertionError(f"{name}: invalid input was accepted")
            if before is not None and path.read_bytes() != before:
                raise AssertionError(f"{name}: source file changed")
    packages = {}
    for name in ("numpy", "soundfile", "soxr", "librosa", "mlx", "mlx-audio"):
        try:
            packages[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            pass
    return {"evidence": "installed-decoder-with-inference-stub", "status": "passed", "backend": backend,
            "nativeInference": False, "platform": platform.platform(),
            "python": platform.python_version(), "packages": packages, "cases": cases}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", choices=("linux", "windows", "mlx"), required=True)
    args = parser.parse_args()
    try:
        report = run_contracts(args.backend)
    except Exception as error:
        print(json.dumps({"evidence": "installed-decoder-with-inference-stub", "backend": args.backend,
                          "nativeInference": False, "status": "failed", "error": str(error),
                          "errorType": type(error).__name__}), file=sys.stderr)
        return 1
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
