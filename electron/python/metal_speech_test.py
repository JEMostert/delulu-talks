"""Dependency-free contract tests for the local HTTP adapter."""
import io
import json
import tempfile
import unittest
import urllib.error
import wave
from pathlib import Path
from metal_speech import MetalSpeech


class MetalContract(unittest.TestCase):
    def test_wav_request_and_detected_language(self):
        speech = MetalSpeech()
        speech.process = type("Running", (), {"poll": lambda self: None})()
        calls = []
        def endpoint(path, data=None, content_type=None, timeout=10):
            calls.append((path, data, content_type))
            return {"text": "  Goedemorgen Nederland.  ", "language": "Dutch"}
        speech._request = endpoint
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "audio.wav"
            with wave.open(str(path), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(16000)
                wav.writeframes(b"\0\0" * 16000)
            result = speech.transcribe({"audioPath": str(path), "language": "en"})
            speech._request = lambda *args, **kwargs: {"text": "Hello"}
            unknown = speech.transcribe({"audioPath": str(path), "language": "nl"})
            self.assertEqual(unknown["language"], "und")
            speech._request = lambda *args, **kwargs: {"error": "bad response"}
            with self.assertRaisesRegex(RuntimeError, "invalid transcription"):
                speech.transcribe({"audioPath": str(path)})
        self.assertEqual(result["text"], "Goedemorgen Nederland.")
        self.assertEqual(result["language"], "nl")
        self.assertEqual(result["duration"], 1)
        self.assertGreaterEqual(result["processingTime"], 0)
        self.assertEqual(calls[0][0], "/v1/audio/transcriptions")
        self.assertIn(b"RIFF", calls[0][1])
        self.assertIn(b"json", calls[0][1])
        self.assertNotIn(b"verbose_json", calls[0][1])
        self.assertNotIn(b'name="language"', calls[0][1])

    def test_failed_endpoint_is_actionable(self):
        speech = MetalSpeech()
        speech.endpoint = "http://127.0.0.1:1234"
        def fail(*args, **kwargs):
            raise urllib.error.HTTPError(speech.endpoint, 503, "unavailable", {}, io.BytesIO(b"model unavailable"))
        speech.http.open = fail
        with self.assertRaisesRegex(RuntimeError, "503.*model unavailable"):
            speech._request("/health")

    def test_dead_server_is_not_ready(self):
        speech = MetalSpeech()
        speech.process = type("Stopped", (), {"poll": lambda self: 1})()
        self.assertFalse(speech.status()["loaded"])
        with self.assertRaisesRegex(RuntimeError, "Load the model"):
            speech.transcribe({"audioPath": "missing.wav"})
        speech.unload()
        self.assertIsNone(speech.process)


if __name__ == "__main__":
    unittest.main()
