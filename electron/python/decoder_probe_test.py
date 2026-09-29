"""Probe routing contracts with mocked decode/inference; no optional installs."""
import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from backend_isolation_test import OPTIONAL_MODULES, forbid_imports

spec = importlib.util.spec_from_file_location(
    "decoder_probe", Path(__file__).resolve().parents[2] / "scripts/decoder-contract.py",
)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class DecoderProbeRouting(unittest.TestCase):
    def test_linux_probe_has_real_worker_initialization_on_any_host(self):
        for system, arch in [("linux", "x86_64"), ("win32", "AMD64"), ("darwin", "arm64")]:
            with self.subTest(system=system), patch.object(sys, "platform", system), \
                    patch.object(probe.platform, "machine", return_value=arch), \
                    forbid_imports(OPTIONAL_MODULES) as attempts:
                worker, captured = probe.make_probe("linux")
                self.assertEqual(worker.speech_backend, "linux")
                self.assertIsNone(worker.speech)
                self.assertFalse(worker.magic_status()["loaded"])
                self.assertEqual(captured, [])
                self.assertEqual(attempts, [])

    def test_linux_probe_reaches_real_decode_and_retries_after_failure(self):
        class Samples:
            ndim = 1

            def __len__(self):
                return 8000

        samples = Samples()
        with tempfile.TemporaryDirectory(prefix="delulu-probe-routing-") as temporary:
            audio = Path(temporary) / "fixture.wav"
            audio.write_bytes(b"Synthetic container fixture, mocked decoder")
            source = audio.read_bytes()
            soundfile = types.SimpleNamespace(read=lambda *args, **kwargs: (samples, 16000))
            with patch.dict(sys.modules, {"soundfile": soundfile}), \
                    patch.object(sys, "platform", "linux"):
                worker, captured = probe.make_probe("linux")
                with patch.object(soundfile, "read", side_effect=RuntimeError("injected decode failure")), \
                        patch.dict(sys.modules, {"librosa": None}):
                    with self.assertRaises(ImportError):
                        worker.transcribe({"audioPath": str(audio)})
                self.assertEqual(captured, [])
                result = worker.transcribe({"audioPath": str(audio), "language": "en"})
                self.assertEqual(captured, [samples])
                self.assertEqual(result["text"], "decoder probe")
                self.assertEqual(result["duration"], 0.5)
                self.assertEqual(audio.read_bytes(), source)


if __name__ == "__main__":
    unittest.main()
