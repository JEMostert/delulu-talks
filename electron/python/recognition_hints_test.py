"""Automatic language and vocabulary hints across the worker boundary, without ML runtimes."""
import sys
import types
import unittest
from unittest.mock import patch

import transcription_engine as engine
import worker_protocol as protocol
from r2t2_speech import R2T2Speech


def request(command, **fields):
    return {"protocolVersion": 1, "id": "operation", "command": command, **fields}


class LanguageHintTests(unittest.TestCase):
    def test_auto_maps_to_model_detection_only_where_the_adapter_allows_it(self):
        self.assertEqual(engine.language_hint({"language": "auto"}), ("auto", None))
        self.assertEqual(engine.language_hint({"language": "NL"}), ("nl", "Dutch"))
        with self.assertRaises(ValueError):
            engine.language_hint({"language": "auto"}, allow_auto=False)
        with self.assertRaises(ValueError):
            engine.language_hint({"language": "xx"})

    def test_only_cuda_r2t2_advertises_automatic_language_and_vocabulary_biasing(self):
        worker = engine.Worker()
        worker.speech_backend = "cuda"
        cuda = worker.capabilities("speech")
        self.assertIn("auto", cuda["languageHints"]["languages"])
        self.assertTrue(cuda["vocabularyBiasing"])
        protocol.validate_result("capabilities", cuda)
        worker.speech_backend = "mlx"
        mlx = worker.capabilities("speech")
        self.assertNotIn("auto", mlx["languageHints"]["languages"])
        self.assertFalse(mlx["vocabularyBiasing"])
        self.assertFalse(worker.capabilities("writing")["vocabularyBiasing"])


class HotwordProtocolTests(unittest.TestCase):
    def test_hotwords_are_bounded_strings(self):
        valid = request("transcribe", audioPath="/tmp/a.wav", language="auto", hotwords="Kestrel, Moondream")
        self.assertIs(protocol.validate_request(valid), valid)
        with self.assertRaises(ValueError):
            protocol.validate_request({**valid, "hotwords": ["Kestrel"]})
        with self.assertRaises(ValueError):
            protocol.validate_request({**valid, "hotwords": "x" * (protocol.MAX_HOTWORDS_CHARS + 1)})


class FakeInputs(dict):
    def to(self, *_args):
        return self


class FakeIds:
    shape = (1, 3)


class FakeProcessor:
    def __init__(self):
        self.calls = []

    def apply_transcription_request(self, **kwargs):
        self.calls.append(kwargs)
        return FakeInputs(input_ids=FakeIds())

    def decode(self, _output, **_kwargs):
        return {"language": "Dutch", "transcription": "Hallo Kestrel"}


class FakeModel:
    device = "cpu"
    dtype = "float32"

    def generate(self, **_kwargs):
        return [[1, 2, 3, 4, 151645]]


class InferenceMode:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class R2T2PromptTests(unittest.TestCase):
    def test_automatic_language_and_hotwords_reach_the_processor(self):
        speech = R2T2Speech()
        speech.processor = FakeProcessor()
        speech.model = FakeModel()
        fake_torch = types.SimpleNamespace(inference_mode=InferenceMode)
        with patch.dict(sys.modules, {"torch": fake_torch}):
            calls = speech.processor.calls
            speech._generate([0.0] * 1600, None, 512, None, "Kestrel, Moondream")
            speech._generate([0.0] * 1600, "Dutch", 512, None, "")
        self.assertIsNone(calls[0]["language"])
        self.assertEqual(calls[0]["prompt"], "Kestrel, Moondream")
        self.assertEqual(calls[1]["language"], "Dutch")
        self.assertIsNone(calls[1]["prompt"])


if __name__ == "__main__":
    unittest.main()
