"""Failure isolation and protocol recovery around expensive backend boundaries."""
import io
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import transcription_engine as engine


class WorkerStateTests(unittest.TestCase):
    def test_failed_speech_load_rolls_back_partial_state_and_allows_explicit_retry(self):
        worker = engine.Worker()
        worker.speech_backend = "linux"
        rewrite_model = worker.magic_model = object()
        failure = RuntimeError("inference failed")

        def acquire(request):
            worker.model = object()
            worker.model_name = "r2t2"
            worker.device = "cuda"
            worker.speech_warmup = "warming"
            raise failure

        with patch.object(worker, "load_speech", side_effect=acquire), patch.object(worker, "clear_allocator"):
            with self.assertRaises(RuntimeError) as caught:
                worker.load({})
        self.assertIs(caught.exception, failure)
        self.assertIsNone(worker.model)
        self.assertIsNone(worker.speech)
        self.assertEqual(worker.status()["residency"], "unloaded")
        self.assertEqual(worker.status()["warmup"], "not-started")
        self.assertIs(worker.magic_model, rewrite_model)
        with patch.object(worker, "load_speech", return_value={"loaded": True}) as retry:
            self.assertTrue(worker.load({})["loaded"])
        retry.assert_called_once_with({})

    def test_failed_inference_cleans_transient_memory_preserves_models_and_original_cause(self):
        worker = engine.Worker()
        speech = worker.model = object()
        rewrite = worker.magic_model = object()
        for boundary, method, fields in (("transcribe_speech", worker.transcribe, {"speech": True}),
                                         ("generate_rewrite", worker.rewrite_magic, {})):
            failure = RuntimeError("backend failed")
            with patch.object(worker, boundary, side_effect=[failure, {"text": "retry succeeded"}]), \
                    patch.object(worker, "clear_allocator") as cleanup:
                with self.assertRaises(RuntimeError) as caught:
                    method({})
                self.assertIs(caught.exception, failure)
                cleanup.assert_called_once_with(**fields)
                self.assertEqual(method({})["text"], "retry succeeded")
            self.assertIs(worker.model, speech)
            self.assertIs(worker.magic_model, rewrite)

    def test_runtime_role_blocks_cross_engine_commands_before_model_access(self):
        worker = engine.Worker()
        for role, forbidden, engine_name in (("speech", "magicLoad", "writing"), ("magic", "load", "speech")):
            with patch.dict(os.environ, {"DELULU_RUNTIME_KIND": role}):
                with self.assertRaisesRegex(ValueError, "not allowed"):
                    worker.dispatch({"command": forbidden})
                with self.assertRaisesRegex(ValueError, "does not match"):
                    worker.dispatch({"command": "capabilities", "engine": engine_name})
                self.assertFalse(worker.dispatch({"command": "ping"})["loaded"])
        for backend in ("linux", "mlx", "windows"):
            worker.speech_backend = backend
            capabilities = worker.capabilities("speech")
            self.assertFalse(capabilities["streaming"])
            engine.validate_result("capabilities", capabilities)

    def test_bad_input_produces_private_error_then_worker_accepts_next_request(self):
        inputs = [b'{"text":"private draft",\n',
                  json.dumps({"protocolVersion": 1, "id": "next", "command": "status"}).encode(),
                  json.dumps({"protocolVersion": 1, "id": "stop", "command": "shutdown"}).encode()]
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(engine.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(b"\n".join(inputs) + b"\n"))), \
                patch.object(engine.sys, "stdout", output), patch.object(engine.sys, "__stdout__", output), \
                patch.object(engine.sys, "stderr", errors), patch.dict(os.environ, {"DELULU_RUNTIME_KIND": ""}):
            self.assertEqual(engine.main(), 0)
        results = [json.loads(line.removeprefix(engine.PROTOCOL_PREFIX))
                   for line in output.getvalue().splitlines() if line.startswith(engine.PROTOCOL_PREFIX)]
        self.assertEqual([result["ok"] for result in results], [False, True, True])
        self.assertEqual([result["id"] for result in results], [None, "next", "stop"])
        self.assertNotIn("private draft", output.getvalue() + errors.getvalue())

    def test_input_and_output_limits_stop_before_unbounded_buffering_or_partial_publication(self):
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(engine, "MAX_REQUEST_BYTES", 16), \
                patch.object(engine.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(b"x" * 32))), \
                patch.object(engine.sys, "stdout", output), patch.object(engine.sys, "stderr", errors):
            self.assertEqual(engine.main(), 2)
        self.assertEqual(output.getvalue(), "")
        self.assertIn("exceeds", errors.getvalue())
        with patch.object(engine, "MAX_RESPONSE_BYTES", 32), patch.object(engine.sys, "stdout", output):
            with self.assertRaisesRegex(ValueError, "response exceeds"):
                engine.emit({"id": "operation", "ok": True, "result": {"text": "a" * 64,
                            "language": "und", "duration": 0, "processingTime": 0}}, "transcribe")
        self.assertEqual(output.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
