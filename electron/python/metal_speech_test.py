"""Dependency-free MLX integration contracts; real Mac inference remains separate."""
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch
from metal_speech import MetalSpeech, MODEL, MODEL_REVISION, MAX_TOKENS


class MlxContract(unittest.TestCase):
    def setUp(self):
        self.downloads = []
        self.loads = []
        self.generations = []
        self.decodes = []
        self.clears = []
        self.output = types.SimpleNamespace(text="  Goedemorgen Nederland.  ", language=["Dutch"])
        self.samples = [0.0] * 16000
        self.failure = None
        self.load_failure = None
        self.decode_failure = None
        self.available = True
        def generate(audio, **kwargs):
            self.generations.append((audio, kwargs))
            if self.failure:
                raise self.failure
            return self.output
        self.model = types.SimpleNamespace(generate=generate)
        def load_model(path, **kwargs):
            self.loads.append((path, kwargs))
            if self.load_failure:
                raise self.load_failure
            return self.model
        def load_audio(path, **kwargs):
            self.decodes.append((path, kwargs))
            if self.decode_failure:
                raise self.decode_failure
            return self.samples
        def download(**kwargs):
            self.downloads.append(kwargs)
            return "/cached/r2t2"
        mlx = types.ModuleType("mlx")
        mlx.core = types.SimpleNamespace(
            metal=types.SimpleNamespace(is_available=lambda: self.available),
            zeros=lambda size, **kwargs: [0.0] * size,
            float32="float32", clear_cache=lambda: self.clears.append(True),
        )
        modules = {"mlx": mlx, "mlx.core": mlx.core,
                   "download_progress": types.SimpleNamespace(download_progress_class=lambda: object),
                   "verified_snapshot": types.SimpleNamespace(verified_snapshot=download),
                   "mlx_audio": types.ModuleType("mlx_audio"),
                   "mlx_audio.stt": types.ModuleType("mlx_audio.stt"),
                   "mlx_audio.stt.utils": types.SimpleNamespace(load_model=load_model, load_audio=load_audio)}
        self.patches = patch.dict(sys.modules, modules)
        self.patches.start()
        self.addCleanup(self.patches.stop)
        self.speech = MetalSpeech()
        self.addCleanup(self.speech.unload)

    def test_load_pins_the_r2t2_fine_tune_and_warms_before_ready(self):
        with patch.dict(os.environ, {"HF_HUB_OFFLINE": "1"}):
            status = self.speech.load({"cacheDir": "/private/models"})
        self.assertEqual(self.downloads[0]["repo_id"], MODEL)
        self.assertEqual(self.downloads[0]["revision"], MODEL_REVISION)
        self.assertEqual(self.downloads[0]["cache_dir"], "/private/models/hub")
        self.assertTrue(self.downloads[0]["local_files_only"])
        self.assertTrue(self.loads[0][1]["strict"])
        self.assertEqual(self.generations[0][1]["max_tokens"], 8)
        self.assertEqual(status, {"loaded": True, "model": MODEL, "device": "mlx",
                                  "residency": "resident", "warmup": "complete",
                                  "speechExecution": {"modelId": "r2t2", "backendId": "mlx-audio",
                                      "precision": "bf16", "checkpoint": {"repository": MODEL, "revision": MODEL_REVISION},
                                      "platform": "darwin", "device": "mlx"}})
        self.speech.load({})
        self.assertEqual(len(self.downloads), 1)
        self.assertEqual(len(self.generations), 1)

    def test_failed_warmup_releases_model_and_can_retry(self):
        self.failure = RuntimeError("Metal allocation failed")
        with self.assertRaisesRegex(RuntimeError, "allocation"):
            self.speech.load({})
        self.assertFalse(self.speech.status()["loaded"])
        self.assertEqual(self.clears, [True])
        self.failure = None
        self.assertTrue(self.speech.load({})["loaded"])

    def test_missing_metal_fails_before_download(self):
        self.available = False
        with self.assertRaisesRegex(RuntimeError, "Apple Silicon"):
            self.speech.load({})
        self.assertEqual(self.downloads, [])

    def test_loader_failure_before_assignment_clears_allocations_and_can_retry(self):
        self.load_failure = ValueError("Missing checkpoint weights")
        with self.assertRaisesRegex(ValueError, "checkpoint weights"):
            self.speech.load({})
        self.assertFalse(self.speech.status()["loaded"])
        self.assertEqual(self.clears, [True])
        self.assertEqual(self.generations, [])
        self.load_failure = None
        self.assertTrue(self.speech.load({})["loaded"])

    def test_compressed_import_uses_decoder_and_honors_language(self):
        self.speech.load({})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "recording.flac"
            path.write_bytes(b"fLaC-compressed-fixture")
            result = self.speech.transcribe({"audioPath": str(path), "language": "nl"})
        self.assertEqual(self.decodes, [(str(path), {"sr": 16000})])
        self.assertEqual(self.generations[-1][1]["language"], "Dutch")
        self.assertEqual(self.generations[-1][1]["temperature"], 0.0)
        # The upstream default is 20 minutes, which creates a very large
        # encoder attention mask. Long imports must use bounded chunks.
        self.assertLessEqual(self.generations[-1][1]["chunk_duration"], 30)
        self.assertEqual(result["text"], "Goedemorgen Nederland.")
        self.assertEqual(result["language"], "nl")
        self.assertEqual(result["duration"], 1)
        self.assertGreaterEqual(result["processingTime"], result["inferenceTime"])
        self.assertGreaterEqual(result["inferenceTime"], 0)

    def test_mixed_or_missing_detected_language_is_not_invented(self):
        self.speech.load({})
        with tempfile.NamedTemporaryFile(suffix=".wav") as audio:
            for detected in (["English", "Dutch"], [], None):
                self.output.language = detected
                result = self.speech.transcribe({"audioPath": audio.name, "language": "nl"})
                self.assertEqual(result["language"], "und")
            self.output.language = ["English", "English"]
            self.assertEqual(self.speech.transcribe({"audioPath": audio.name})["language"], "en")

    def test_invalid_output_and_empty_audio_produce_errors(self):
        self.speech.load({})
        with tempfile.NamedTemporaryFile() as audio:
            self.output = types.SimpleNamespace(error="bad output")
            with self.assertRaisesRegex(RuntimeError, "invalid transcription"):
                self.speech.transcribe({"audioPath": audio.name})
            self.samples = []
            with self.assertRaisesRegex(ValueError, "no samples"):
                self.speech.transcribe({"audioPath": audio.name})

    def test_unload_releases_memory_and_missing_model_is_actionable(self):
        self.speech.load({})
        self.speech.unload()
        self.speech.unload()
        self.assertEqual(self.clears, [True])
        self.assertFalse(self.speech.status()["loaded"])
        with self.assertRaisesRegex(RuntimeError, "Load the model"):
            self.speech.transcribe({"audioPath": "missing.wav"})

    def test_missing_file_and_decoder_failure_do_not_invoke_inference(self):
        self.speech.load({})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "recording.wav"
            with self.assertRaises(FileNotFoundError):
                self.speech.transcribe({"audioPath": str(path)})
            self.assertEqual(self.decodes, [])
            path.write_bytes(b"corrupt audio")
            self.decode_failure = ValueError("Unsupported audio encoding")
            with self.assertRaisesRegex(ValueError, "encoding"):
                self.speech.transcribe({"audioPath": str(path)})
        self.assertEqual(len(self.generations), 1)  # warmup only
        self.assertTrue(self.speech.status()["loaded"])

    def test_generation_failure_clears_cache_and_model_can_retry(self):
        self.speech.load({})
        with tempfile.NamedTemporaryFile() as audio:
            self.failure = RuntimeError("Metal out of memory")
            with self.assertRaisesRegex(RuntimeError, "out of memory"):
                self.speech.transcribe({"audioPath": audio.name})
            self.assertEqual(self.clears, [True])
            self.assertTrue(self.speech.status()["loaded"])
            self.failure = None
            self.assertEqual(self.speech.transcribe({"audioPath": audio.name})["language"], "nl")

    def test_exhausted_total_token_budget_is_reported_as_incomplete(self):
        self.speech.load({})
        self.output.generation_tokens = MAX_TOKENS
        with tempfile.NamedTemporaryFile() as audio:
            with self.assertRaisesRegex(RuntimeError, "shorter files"):
                self.speech.transcribe({"audioPath": audio.name})


if __name__ == "__main__":
    unittest.main()
