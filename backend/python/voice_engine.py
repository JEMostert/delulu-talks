"""Delulu Voice: local text-to-speech for the voice runtime role.

Small is Kokoro 82M through sherpa-onnx on the CPU. Large is Chatterbox Turbo
through PyTorch, preferably on a GPU, which performs non-verbal sounds and
speaking styles natively and can clone a voice from a reference clip.

The desktop parses Grok-style markup and sends short chunks of parts that
share one style set (see src/voice.ts). Planning how those parts map onto an
engine is plain Python, so it is testable without numpy or torch; audio
libraries are imported only when a model loads or speaks.
"""
from __future__ import annotations

import base64
import gc
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from worker_protocol import emit_progress

ENGINES = ("kokoro", "chatterbox-turbo")
SAMPLE_RATE = 24_000
MAX_AUDIO_SECONDS = 90
# An event Kokoro cannot perform becomes a short pause, so rhythm stays natural.
SKIPPED_EVENT_MS = 250
# Silence kept around each synthesized run after trimming.
EDGE_MS = 80
# Chatterbox Turbo generates at most 1000 speech tokens (~40 s) per call.
CHATTERBOX_RUN_CHARACTERS = 250
TARGET_RMS_DBFS = -20.0
PEAK_LIMIT_DBFS = -1.0
MIN_REFERENCE_SECONDS = 5.0

CHECKPOINTS: dict[str, dict[str, Any]] = {
    "kokoro": {
        "name": "Kokoro 82M",
        "repository": "csukuangfj/kokoro-multi-lang-v1_0",
        "revision": "f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b",
        "patterns": ["model.onnx", "voices.bin", "tokens.txt", "lexicon-us-en.txt",
                     "lexicon-gb-en.txt", "espeak-ng-data/*"],
        "weights": ".onnx",
    },
    "chatterbox-turbo": {
        "name": "Chatterbox Turbo",
        "repository": "ResembleAI/chatterbox-turbo",
        "revision": "749d1c1a46eb10492095d68fbcf55691ccf137cd",
        # Turbo loads the meanflow decoder only; the 1 GB s3gen.safetensors is unused.
        "patterns": ["ve.safetensors", "t3_turbo_v1.safetensors", "s3gen_meanflow.safetensors",
                     "*.json", "*.txt", "conds.pt"],
        "weights": ".safetensors",
    },
}

# Speaker ids from the Kokoro v1.0 model metadata (id2speaker).
KOKORO_SPEAKERS = {
    "af_alloy": 0, "af_aoede": 1, "af_bella": 2, "af_heart": 3, "af_jessica": 4, "af_kore": 5,
    "af_nicole": 6, "af_nova": 7, "af_river": 8, "af_sarah": 9, "af_sky": 10, "am_adam": 11,
    "am_echo": 12, "am_eric": 13, "am_fenrir": 14, "am_liam": 15, "am_michael": 16, "am_onyx": 17,
    "am_puck": 18, "am_santa": 19, "bf_alice": 20, "bf_emma": 21, "bf_isabella": 22, "bf_lily": 23,
    "bm_daniel": 24, "bm_fable": 25, "bm_george": 26, "bm_lewis": 27,
}
DEFAULT_KOKORO_VOICE = "af_heart"

EVENT_TAGS = ("laugh", "chuckle", "sigh", "gasp", "cough", "clear-throat", "sniff", "groan", "shush")
EMOTION_STYLES = ("whisper", "happy", "angry", "surprised", "scared", "sarcastic", "dramatic",
                  "narration", "crying")
PROSODY_STYLES = ("slow", "fast", "soft", "loud", "emphasis")

# Chatterbox Turbo's added tokens (added_tokens.json at the pinned revision).
CHATTERBOX_EVENTS = {tag: f"[{tag.replace('-', ' ')}]" for tag in EVENT_TAGS}
CHATTERBOX_STYLES = {
    "whisper": "[whispering]", "happy": "[happy]", "angry": "[angry]", "surprised": "[surprised]",
    "scared": "[fear]", "sarcastic": "[sarcastic]", "dramatic": "[dramatic]",
    "narration": "[narration]", "crying": "[crying]",
}
# Rate multipliers and gains (dB) applied for pacing and volume styles.
PROSODY = {"slow": (0.85, 0.0), "fast": (1.15, 0.0), "emphasis": (0.92, 3.0),
           "soft": (1.0, -6.0), "loud": (1.0, 4.0)}
# Kokoro has no whisper; a quieter, slightly slower voice approximates it.
KOKORO_WHISPER = (0.95, -8.0)
# Chatterbox whispers natively; keep it a little quieter after loudness levelling.
CHATTERBOX_WHISPER_GAIN = -4.0


class VoiceInputError(ValueError):
    """A user-facing problem with the voice request, shown verbatim."""


@dataclass
class Run:
    """Either speech to synthesize or silence to insert."""

    kind: str
    text: str = ""
    ms: int = 0


@dataclass
class Plan:
    runs: list[Run]
    # Speaking rate: Kokoro's native speed, or a time stretch after Chatterbox.
    rate: float
    gain_db: float
    unsupported: list[str] = field(default_factory=list)


def db_to_gain(db: float) -> float:
    return 10.0 ** (db / 20.0)


def _dedupe(items: list[str]) -> list[str]:
    seen: list[str] = []
    for item in items:
        if item not in seen:
            seen.append(item)
    return seen


def _clean_text(text: str) -> str:
    # Only event parts may produce engine tokens; literal brackets in text
    # must not trigger a Chatterbox sound or be read as markup.
    return text.replace("[", "(").replace("]", ")")


# A piece starting with one of these attaches to the previous piece without a space.
ATTACHING = ".,!?;:)…"


def join_pieces(pieces: list[str]) -> str:
    """Join trimmed text parts and sound tokens with single spaces, except before
    punctuation: "my fault", "[laugh]", ". Fixed it" -> "my fault [laugh]. Fixed it"."""
    joined = ""
    for piece in pieces:
        piece = " ".join(piece.split())
        if not piece:
            continue
        if joined and piece[0] not in ATTACHING:
            joined += " "
        joined += piece
    return joined


def _speakable(text: str, engine: str) -> bool:
    if any(character.isalnum() for character in text):
        return True
    return engine == "chatterbox-turbo" and any(token in text for token in CHATTERBOX_EVENTS.values())


def split_sentences(text: str, limit: int) -> list[str]:
    """Split text longer than `limit` at sentence ends, then at spaces."""
    text = " ".join(text.split())
    if len(text) <= limit:
        return [text] if text else []
    pieces: list[str] = []
    current = ""
    for sentence in re.split(r"(?<=[.!?;])\s+", text):
        while len(sentence) > limit:
            cut = sentence.rfind(" ", 0, limit)
            cut = cut if cut > 0 else limit
            if current:
                pieces.append(current)
                current = ""
            pieces.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        if current and len(current) + 1 + len(sentence) > limit:
            pieces.append(current)
            current = sentence
        else:
            current = f"{current} {sentence}".strip()
    if current:
        pieces.append(current)
    return [piece for piece in pieces if piece]


def style_effects(engine: str, styles: list[str]) -> tuple[float, float, list[str], list[str]]:
    """Return (rate, gain dB, leading tokens, unsupported styles) for a style set."""
    rate, gain = 1.0, 0.0
    tokens: list[str] = []
    unsupported: list[str] = []
    for style in styles:
        if style in PROSODY:
            multiplier, decibels = PROSODY[style]
            rate *= multiplier
            gain += decibels
        elif engine == "chatterbox-turbo" and style in CHATTERBOX_STYLES:
            tokens.append(CHATTERBOX_STYLES[style])
            if style == "whisper":
                gain += CHATTERBOX_WHISPER_GAIN
        elif style == "whisper":
            multiplier, decibels = KOKORO_WHISPER
            rate *= multiplier
            gain += decibels
        else:
            unsupported.append(style)
    return rate, gain, tokens, unsupported


def plan_synthesis(engine: str, parts: list[dict[str, Any]], styles: list[str], speed: float) -> Plan:
    """Map validated parts onto speech and silence runs for one engine."""
    if engine not in ENGINES:
        raise ValueError("Unsupported voice engine")
    rate, gain, tokens, unsupported = style_effects(engine, list(styles))
    runs: list[Run] = []
    buffer: list[str] = []

    def silence(ms: float) -> None:
        ms = int(round(ms))
        if ms <= 0:
            return
        if runs and runs[-1].kind == "silence":
            runs[-1].ms += ms
        else:
            runs.append(Run("silence", ms=ms))

    def flush() -> None:
        text = join_pieces(buffer)
        buffer.clear()
        if engine == "kokoro":
            # After a skipped sound the next part can start with its punctuation.
            text = text.lstrip(ATTACHING + " ")
        if not _speakable(text, engine):
            return
        limit = CHATTERBOX_RUN_CHARACTERS if engine == "chatterbox-turbo" else 10_000
        for piece in split_sentences(text, limit):
            if _speakable(piece, engine):
                prefix = " ".join(tokens)
                runs.append(Run("speech", text=f"{prefix} {piece}".strip() if prefix else piece))

    for part in parts:
        kind = part["kind"]
        if kind == "text":
            buffer.append(_clean_text(part["text"]))
        elif kind == "event":
            if engine == "chatterbox-turbo":
                buffer.append(CHATTERBOX_EVENTS[part["tag"]])
            else:
                flush()
                unsupported.append(part["tag"])
                silence(SKIPPED_EVENT_MS)
        else:
            flush()
            silence(part["ms"])
    flush()
    return Plan(runs=runs, rate=max(0.25, min(4.0, rate * speed)), gain_db=gain,
                unsupported=_dedupe(unsupported))


def threads() -> int:
    return max(1, min(4, os.cpu_count() or 1))


def offline() -> bool:
    return os.environ.get("HF_HUB_OFFLINE") == "1"


def download(engine: str, request: dict[str, Any]) -> str:
    from verified_snapshot import verified_snapshot

    checkpoint = CHECKPOINTS[engine]
    cache_root = request.get("cacheDir")
    options = dict(repo_id=checkpoint["repository"], revision=checkpoint["revision"],
                   cache_dir=str(Path(cache_root) / "hub") if cache_root else None,
                   allow_patterns=list(checkpoint["patterns"]), weights_suffix=checkpoint["weights"])
    emit_progress(f"Checking the pinned {checkpoint['name']} voice files…", stage="download")
    # Kokoro has hundreds of pronunciation files; re-checking each one online on
    # every load takes most of a minute. A complete verified snapshot is checked
    # against its recorded digests locally, and only a missing or damaged one
    # goes back online.
    try:
        return verified_snapshot(local_files_only=True, **options)
    except RuntimeError:
        if offline():
            raise
    emit_progress(f"Downloading the pinned {checkpoint['name']} voice…", stage="download")
    return verified_snapshot(local_files_only=False, **options)


class KokoroVoice:
    engine = "kokoro"

    def __init__(self) -> None:
        self.directory: str | None = None
        # The espeak voice is fixed per instance; British voices get their own.
        self.instances: dict[str, Any] = {}
        self.warmup = "not-started"

    @property
    def loaded(self) -> bool:
        return bool(self.instances)

    @property
    def device(self) -> str | None:
        return "cpu" if self.loaded else None

    def _instance(self, british: bool):
        key = "gb" if british else "us"
        if key in self.instances:
            return self.instances[key]
        import sherpa_onnx

        directory = Path(str(self.directory))
        # espeak-ng names British English "en"; "en-gb" is not a valid voice there.
        config = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                    model=str(directory / "model.onnx"), voices=str(directory / "voices.bin"),
                    tokens=str(directory / "tokens.txt"), data_dir=str(directory / "espeak-ng-data"),
                    lexicon=str(directory / ("lexicon-gb-en.txt" if british else "lexicon-us-en.txt")),
                    lang="en" if british else "en-us"),
                num_threads=threads(), provider="cpu"),
            max_num_sentences=1)
        if not config.validate():
            raise RuntimeError("The Kokoro voice files are incomplete. Repair the voice model and retry.")
        instance = sherpa_onnx.OfflineTts(config)
        self.instances[key] = instance
        return instance

    def load(self, request: dict[str, Any]) -> None:
        if self.loaded:
            return
        self.directory = download(self.engine, request)
        emit_progress("Loading Kokoro 82M on the CPU…", stage="load")
        try:
            self._instance(british=False)
            self.warmup = "warming"
            emit_progress("Warming up local speech synthesis…", stage="warmup")
            self.speak("Ready.", DEFAULT_KOKORO_VOICE, 1.0, None)
            self.warmup = "complete"
        except BaseException:
            self.unload()
            raise

    def unload(self) -> None:
        self.instances = {}
        self.warmup = "not-started"
        gc.collect()

    def speak(self, text: str, voice: str, rate: float, reference: str | None):
        import numpy as np

        if voice not in KOKORO_SPEAKERS:
            raise VoiceInputError("This Kokoro voice is not available. Choose another voice in Voice settings.")
        instance = self._instance(british=voice.startswith("b"))
        audio = instance.generate(text, sid=KOKORO_SPEAKERS[voice], speed=float(rate))
        samples = np.asarray(audio.samples, dtype=np.float32)
        if audio.sample_rate != SAMPLE_RATE and samples.size:
            import soxr
            samples = soxr.resample(samples, audio.sample_rate, SAMPLE_RATE).astype(np.float32)
        return samples


class ChatterboxVoice:
    engine = "chatterbox-turbo"

    def __init__(self) -> None:
        self.model: Any | None = None
        self.builtin: Any | None = None
        self.reference_key: tuple[str, int, int] | None = None
        # Prepared conditionals per clip; small, since each is a few hundred KB.
        self.references: dict[tuple[str, int, int], Any] = {}
        self.device: str | None = None
        self.warmup = "not-started"

    @property
    def loaded(self) -> bool:
        return self.model is not None

    @staticmethod
    def pick_device(request: dict[str, Any]) -> str:
        import torch

        if request.get("device") == "cpu":
            return "cpu"
        if torch.cuda.is_available():
            return "cuda"
        if bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()):
            return "mps"
        return "cpu"

    def load(self, request: dict[str, Any]) -> None:
        if self.loaded:
            return
        directory = download(self.engine, request)
        os.environ.setdefault("TQDM_DISABLE", "1")
        device = self.pick_device(request)
        emit_progress(f"Loading Chatterbox Turbo on the {'GPU' if device != 'cpu' else 'CPU'}…", stage="load")
        try:
            from chatterbox.tts_turbo import ChatterboxTurboTTS

            self.model = ChatterboxTurboTTS.from_local(directory, device)
            keep_float32(self.model)
            self.builtin = self.model.conds
            if self.builtin is None:
                raise RuntimeError("The Chatterbox Turbo checkpoint has no built-in voice. Repair the voice model.")
            self.device = device
            self.warmup = "warming"
            emit_progress("Warming up expressive speech synthesis…", stage="warmup")
            self.speak("Ready.", "default", 1.0, None)
            self.warmup = "complete"
        except BaseException:
            self.unload()
            raise

    def unload(self) -> None:
        self.model = None
        self.builtin = None
        self.reference_key = None
        self.references = {}
        self.device = None
        self.warmup = "not-started"
        gc.collect()

    def _conditionals(self, reference: str | None) -> None:
        assert self.model is not None
        if reference is None:
            if self.reference_key is not None:
                self.model.conds = self.builtin
                self.reference_key = None
            return
        path = Path(reference)
        try:
            stat = path.stat()
        except OSError as exc:
            raise VoiceInputError("The voice clip is missing. Choose it again in Voice settings.") from exc
        key = (str(path), stat.st_mtime_ns, stat.st_size)
        if key == self.reference_key:
            return
        if key not in self.references:
            if reference_seconds(path) < MIN_REFERENCE_SECONDS:
                raise VoiceInputError("The voice clip must be at least 5 seconds long. Choose a longer clip.")
            try:
                self.model.prepare_conditionals(str(path))
            except (AssertionError, RuntimeError, ValueError, OSError) as exc:
                self.model.conds = self.builtin
                self.reference_key = None
                raise VoiceInputError("This voice clip could not be used. Choose a clear recording of one speaker.") from exc
            if len(self.references) >= 4:
                self.references.pop(next(iter(self.references)))
            self.references[key] = self.model.conds
        self.model.conds = self.references[key]
        self.reference_key = key

    def speak(self, text: str, voice: str, rate: float, reference: str | None):
        import numpy as np

        if self.model is None:
            raise RuntimeError("No voice model is loaded")
        self._conditionals(reference)
        import torch

        with torch.inference_mode():
            wav = self.model.generate(text)
        samples = wav.squeeze(0).detach().cpu().numpy().astype(np.float32)
        if abs(rate - 1.0) > 0.02 and samples.size > 2048:
            import librosa
            samples = librosa.effects.time_stretch(samples, rate=float(rate)).astype(np.float32)
        return samples


def keep_float32(model: Any) -> None:
    """Chatterbox levels reference clips with a float64 gain; under NumPy 2 that
    promotes the clip to float64 and the tokenizer's float32 mel filters fail."""
    import numpy as np

    level = model.norm_loudness

    def norm_loudness(wav, sr, target_lufs=-27):
        return np.asarray(level(wav, sr, target_lufs), dtype=np.float32)

    model.norm_loudness = norm_loudness


def reference_seconds(path: Path) -> float:
    try:
        import soundfile as sf
        return float(sf.info(str(path)).duration)
    except Exception:
        pass
    try:
        import librosa
        return float(librosa.get_duration(path=str(path)))
    except Exception as exc:
        raise VoiceInputError("This voice clip could not be read. Use a WAV, FLAC, MP3 or OGG file.") from exc


def trim(samples, sample_rate: int = SAMPLE_RATE, threshold_dbfs: float = -45.0):
    """Trim leading and trailing near-silence, keeping a short natural edge."""
    import numpy as np

    if not samples.size:
        return samples
    level = db_to_gain(threshold_dbfs)
    loud = np.flatnonzero(np.abs(samples) > level)
    if not loud.size:
        return samples[:0]
    edge = int(sample_rate * EDGE_MS / 1000)
    return samples[max(0, int(loud[0]) - edge):min(samples.size, int(loud[-1]) + edge + 1)]


def finish(samples, gain_db: float):
    """Level loudness gently, apply the style gain and keep peaks below -1 dBFS."""
    import numpy as np

    if not samples.size:
        return samples
    voiced = samples[np.abs(samples) > db_to_gain(-45.0)]
    rms = float(np.sqrt(np.mean(np.square(voiced, dtype=np.float64)))) if voiced.size else 0.0
    scale = db_to_gain(TARGET_RMS_DBFS) / rms if rms > 1e-6 else 1.0
    scale = min(4.0, max(0.25, scale)) * db_to_gain(gain_db)
    samples = samples * scale
    peak = float(np.max(np.abs(samples)))
    limit = db_to_gain(PEAK_LIMIT_DBFS)
    if peak > limit:
        samples = samples * (limit / peak)
    return samples.astype(np.float32)


def encode_pcm16(samples) -> str:
    import numpy as np

    clipped = np.clip(samples, -1.0, 1.0)
    return base64.b64encode((clipped * 32767.0).round().astype("<i2").tobytes()).decode("ascii")


class VoiceEngine:
    """Owns at most one loaded voice adapter for the voice runtime role."""

    def __init__(self) -> None:
        self.adapter: KokoroVoice | ChatterboxVoice | None = None

    def status(self) -> dict[str, Any]:
        adapter = self.adapter
        loaded = adapter is not None and adapter.loaded
        return {
            "loaded": loaded,
            "model": CHECKPOINTS[adapter.engine]["repository"] if loaded else None,
            "device": adapter.device if loaded else None,
            "residency": "resident" if loaded else "unloaded",
            "warmup": adapter.warmup if loaded else "not-started",
            "engine": adapter.engine if loaded else None,
        }

    def load(self, request: dict[str, Any]) -> dict[str, Any]:
        engine = request.get("engine")
        if engine not in ENGINES:
            raise ValueError("Unsupported voice engine")
        if self.adapter is not None and self.adapter.engine != engine:
            self.unload()
        if self.adapter is None:
            self.adapter = KokoroVoice() if engine == "kokoro" else ChatterboxVoice()
        try:
            self.adapter.load(request)
        except BaseException:
            self.unload()
            raise
        return self.status()

    def unload(self) -> dict[str, Any]:
        if self.adapter is not None:
            self.adapter.unload()
        self.adapter = None
        return self.status()

    def synthesize(self, request: dict[str, Any]) -> dict[str, Any]:
        adapter = self.adapter
        if adapter is None or not adapter.loaded:
            raise VoiceInputError("The voice model is not loaded. Load it and retry.")
        if adapter.engine != request.get("engine"):
            raise VoiceInputError("A different voice model is loaded. Load the selected voice and retry.")
        import numpy as np

        started = time.perf_counter()
        plan = plan_synthesis(adapter.engine, request["parts"], request.get("styles", []),
                              float(request.get("speed", 1.0)))
        reference = request.get("reference")
        pieces = []
        total = 0
        limit = MAX_AUDIO_SECONDS * SAMPLE_RATE
        for run in plan.runs:
            if run.kind == "silence":
                piece = np.zeros(int(SAMPLE_RATE * run.ms / 1000), dtype=np.float32)
            else:
                piece = trim(adapter.speak(run.text, str(request.get("voice", "")), plan.rate, reference))
            total += piece.size
            if total > limit:
                raise VoiceInputError("This passage is too long to speak in one piece. Split it into shorter sentences.")
            pieces.append(piece)
        samples = np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)
        samples = finish(samples, plan.gain_db)
        return {
            "sampleRate": SAMPLE_RATE,
            "audio": encode_pcm16(samples),
            "durationMs": round(samples.size * 1000 / SAMPLE_RATE, 1),
            "processingTimeMs": round((time.perf_counter() - started) * 1000, 1),
            "engine": adapter.engine,
            "device": adapter.device or "cpu",
            "unsupported": plan.unsupported[:32],
        }
