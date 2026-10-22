"""Audio intake shared by the speech adapters: 16 kHz mono float32 samples.

Dictation and imports arrive as files soundfile can read (FFmpeg converts other
formats first). Long recordings are split at quiet points before inference.
"""
from __future__ import annotations

from pathlib import Path

SAMPLE_RATE = 16000


def chunk_bounds(samples, chunk: int, search: int = 2 * SAMPLE_RATE, frame: int = SAMPLE_RATE // 50):
    """Split at the quietest 20 ms frame near each chunk boundary.

    Fixed cuts split words across two model calls. Searching up to `search`
    samples before the boundary keeps every chunk at most `chunk` long.
    """
    total = len(samples)
    bounds = []
    start = 0
    while total - start > chunk:
        target = start + chunk
        best, best_energy = target, None
        position = max(start + frame, target - search)
        while position + frame <= target:
            energy = sum(float(value) * float(value) for value in samples[position:position + frame])
            if best_energy is None or energy < best_energy:
                best, best_energy = position + frame // 2, energy
            position += frame
        bounds.append((start, best))
        start = best
    bounds.append((start, total))
    return bounds


def read_audio(path: str | Path):
    """Return (samples, duration in seconds) as 16 kHz mono float32."""
    source = Path(path)
    if not source.is_file():
        raise FileNotFoundError("The selected audio file no longer exists")
    import soundfile as sf
    try:
        samples, rate = sf.read(str(source), dtype="float32", always_2d=False)
    except RuntimeError as exc:
        raise ValueError("This audio format could not be read. Convert it to WAV or FLAC and retry.") from exc
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    duration = len(samples) / rate if rate else 0.0
    if rate != SAMPLE_RATE:
        import soxr
        samples = soxr.resample(samples, rate, SAMPLE_RATE)
    if not len(samples):
        raise ValueError("The selected audio file contains no samples")
    return samples, duration
