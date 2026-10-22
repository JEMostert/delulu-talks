"""CPU speech adapter language handling, chunking and unload without sherpa-onnx."""
import importlib.util
import os
import tempfile
import unittest
import wave
from types import SimpleNamespace
from unittest.mock import patch

import onnx_speech


class FakeStream:
    def __init__(self, recognizer):
        self.recognizer = recognizer
        self.result = SimpleNamespace(text="")

    def accept_waveform(self, rate, samples):
        self.recognizer.inputs.append((rate, len(samples)))


class FakeRecognizer:
    def __init__(self):
        self.inputs = []

    def create_stream(self):
        return FakeStream(self)

    def decode_stream(self, stream):
        stream.result.text = f" part{len(self.inputs)} "


def loaded(model, language="en"):
    adapter = onnx_speech.OnnxSpeech(model)
    adapter.recognizers[language] = FakeRecognizer()
    adapter.warmup = "complete"
    return adapter


class OnnxSpeechTests(unittest.TestCase):
    def test_reports_cpu_execution_for_each_tier_checkpoint(self):
        for model, family in (("canary-180m", "canary"), ("parakeet-v2", "parakeet"), ("parakeet-v3", "parakeet")):
            status = loaded(model).status()
            self.assertTrue(status["loaded"])
            self.assertEqual(status["device"], "cpu")
            execution = status["speechExecution"]
            self.assertEqual((execution["modelId"], execution["backendId"], execution["precision"]),
                             (family, "onnx-cpu", "int8"))
            self.assertRegex(execution["checkpoint"]["revision"], r"^[a-f0-9]{40}$")

    def test_unknown_models_are_rejected(self):
        with self.assertRaises(ValueError):
            onnx_speech.OnnxSpeech("redux")

    def test_canary_accepts_its_four_languages_and_rejects_others(self):
        adapter = loaded("canary-180m")
        self.assertEqual(adapter._language({"language": "DE"}), "de")
        for language in ("nl", "auto"):
            with self.subTest(language=language), self.assertRaisesRegex(ValueError, "supports en, de, fr, es"):
                adapter._language({"language": language})

    def test_parakeet_v3_always_detects_the_language(self):
        adapter = loaded("parakeet-v3", "auto")
        self.assertEqual(adapter._language({"language": "nl"}), "auto")
        self.assertEqual(adapter._language({}), "auto")

    def test_unload_releases_recognizers(self):
        adapter = loaded("parakeet-v2")
        status = adapter.unload()
        self.assertFalse(status["loaded"])
        self.assertEqual(adapter.recognizers, {})
        self.assertEqual(adapter.warmup, "not-started")

    def test_transcribe_requires_a_loaded_model(self):
        with self.assertRaisesRegex(RuntimeError, "No model is loaded"):
            onnx_speech.OnnxSpeech("canary-180m").transcribe({"audioPath": "missing.wav"})

    @unittest.skipUnless(importlib.util.find_spec("numpy") and importlib.util.find_spec("soundfile"),
                         "numpy and soundfile are speech runtime packages")
    def test_long_canary_audio_is_decoded_in_chunks_of_at_most_thirty_seconds(self):
        adapter = loaded("canary-180m")
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "speech.wav")
            with wave.open(path, "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(16000)
                output.writeframes(b"\x01\x00" * 16000 * 70)
            result = adapter.transcribe({"audioPath": path, "language": "en"})
        recognizer = adapter.recognizers["en"]
        self.assertEqual(len(recognizer.inputs), 3)
        self.assertTrue(all(length <= 30 * 16000 for _, length in recognizer.inputs))
        self.assertEqual(result["text"], "part1 part2 part3")
        self.assertEqual(result["language"], "en")
        self.assertAlmostEqual(result["duration"], 70)


if __name__ == "__main__":
    unittest.main()
