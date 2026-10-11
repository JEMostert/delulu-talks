"""Parakeet Redux unload and audio intake without Kestrel, torch or network."""
import importlib.util
import os
import sys
import tempfile
import types
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import redux_speech


def _importable(name):
    return importlib.util.find_spec(name) is not None


class FakeSamples(list):
    ndim = 1


class FakeRuntime:
    def __init__(self, shutdown_error=None):
        self.shutdown_error = shutdown_error
        self.inputs = []

    def shutdown(self):
        if self.shutdown_error is not None:
            raise self.shutdown_error

    def forward(self, task, items):
        self.inputs.append(items)
        return [{"text": " hello redux "}]


class ReduxSpeechTests(unittest.TestCase):
    def test_unload_collects_garbage_and_clears_state_when_shutdown_raises(self):
        adapter = redux_speech.ReduxSpeech()
        adapter.runtime = FakeRuntime(shutdown_error=RuntimeError("shutdown failed"))
        adapter.warmup = "complete"
        with patch.object(redux_speech.gc, "collect") as collect:
            with self.assertRaisesRegex(RuntimeError, "shutdown failed"):
                adapter.unload()
        collect.assert_called_once_with()
        self.assertIsNone(adapter.runtime)
        self.assertEqual(adapter.warmup, "not-started")
        self.assertFalse(adapter.status()["loaded"])

    def test_transcribe_uses_librosa_when_soundfile_cannot_read_the_file(self):
        adapter = redux_speech.ReduxSpeech()
        runtime = adapter.runtime = FakeRuntime()
        def unsupported(*args, **kwargs):
            raise RuntimeError("unsupported format")

        soundfile = types.ModuleType("soundfile")
        soundfile.read = unsupported
        librosa = types.ModuleType("librosa")
        librosa.load = lambda path, sr, mono: (FakeSamples([0.0] * 16000), sr)
        soxr = types.ModuleType("soxr")
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "clip.m4a"
            audio.write_bytes(b"not decoded by the fake")
            with patch.dict(sys.modules, {"soundfile": soundfile, "librosa": librosa, "soxr": soxr}):
                result = adapter.transcribe({"audioPath": str(audio)})
        self.assertEqual(result["text"], "hello redux")
        self.assertEqual(result["duration"], 1.0)
        self.assertEqual(len(runtime.inputs[0][0]["audio"]), 16000)

    def test_transcribe_rejects_decoded_audio_without_samples(self):
        adapter = redux_speech.ReduxSpeech()
        runtime = adapter.runtime = FakeRuntime()
        soundfile = types.ModuleType("soundfile")
        soundfile.read = lambda *args, **kwargs: (FakeSamples(), 16000)
        soxr = types.ModuleType("soxr")
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "empty.wav"
            audio.write_bytes(b"placeholder")
            with patch.dict(sys.modules, {"soundfile": soundfile, "soxr": soxr}):
                with self.assertRaisesRegex(ValueError, "contains no samples"):
                    adapter.transcribe({"audioPath": str(audio)})
        self.assertEqual(runtime.inputs, [])

    @unittest.skipUnless(_importable("soundfile") and _importable("soxr"),
                         "soundfile and soxr are required to decode a real WAV")
    def test_transcribe_rejects_an_empty_wav_file(self):
        adapter = redux_speech.ReduxSpeech()
        runtime = adapter.runtime = FakeRuntime()
        with tempfile.TemporaryDirectory() as directory:
            audio = os.path.join(directory, "empty.wav")
            with wave.open(audio, "wb") as writer:
                writer.setnchannels(1)
                writer.setsampwidth(2)
                writer.setframerate(16000)
            with self.assertRaisesRegex(ValueError, "contains no samples"):
                adapter.transcribe({"audioPath": audio})
        self.assertEqual(runtime.inputs, [])


if __name__ == "__main__":
    unittest.main()
