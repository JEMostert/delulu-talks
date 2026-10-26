"""Failure isolation and protocol recovery around expensive backend boundaries."""
import io
import json
import os
import sys
import types
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import transcription_engine as engine


class WorkerStateTests(unittest.TestCase):
    def test_failed_speech_load_rolls_back_partial_state_and_allows_explicit_retry(self):
        worker = engine.Worker()
        rewrite_model = worker.magic_model = object()
        failure = RuntimeError("inference failed")

        class Adapter:
            calls = 0

            def load(self, request):
                Adapter.calls += 1
                if Adapter.calls == 1:
                    raise failure
                return {"loaded": True}

            def unload(self):
                return {"loaded": False}

        def engine_for(model=None):
            if worker.speech is None:
                worker.speech = Adapter()
            return worker.speech

        with patch.object(worker, "speech_engine", side_effect=engine_for), \
                patch.object(worker, "clear_allocator"):
            worker.speech = None
            with self.assertRaises(RuntimeError) as caught:
                worker.load({})
            self.assertIs(caught.exception, failure)
            self.assertIsNone(worker.speech)
            self.assertEqual(worker.status()["residency"], "unloaded")
            self.assertIs(worker.magic_model, rewrite_model)
            self.assertTrue(worker.load({})["loaded"])

    def test_failed_inference_cleans_transient_memory_preserves_models_and_original_cause(self):
        worker = engine.Worker()
        speech = worker.speech = object()
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
            self.assertIs(worker.speech, speech)
            self.assertIs(worker.magic_model, rewrite)

    def test_runtime_role_blocks_cross_engine_commands_before_model_access(self):
        worker = engine.Worker()
        for role, forbidden, engine_name in (("speech", "magicLoad", "writing"), ("magic", "load", "speech")):
            with patch.dict(os.environ, {"DELULU_RUNTIME_KIND": role}):
                with self.assertRaisesRegex(ValueError, "not allowed"):
                    worker.dispatch({"command": forbidden})
                with self.assertRaisesRegex(ValueError, "does not match"):
                    worker.dispatch({"command": "capabilities", "engine": engine_name})
                status = "status" if role == "speech" else "magicStatus"
                self.assertFalse(worker.dispatch({"command": status})["loaded"])
        for backend in ("cuda", "mlx"):
            worker.speech_backend = backend
            capabilities = worker.capabilities("speech")
            self.assertNotIn("streaming", capabilities)
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


class FakeInputs(dict):
    def to(self, device):
        return self


class NoGrad:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class MagicWarmupTests(unittest.TestCase):
    def fake_torch(self):
        return SimpleNamespace(inference_mode=NoGrad, cuda=SimpleNamespace(is_available=lambda: False),
                               backends=SimpleNamespace(mps=None))

    def loaded_worker(self, generate):
        worker = engine.Worker()
        worker.magic_model = SimpleNamespace(generate=generate)
        worker.magic_processor = SimpleNamespace(
            apply_chat_template=lambda messages, **kwargs: FakeInputs(input_ids=SimpleNamespace(shape=(1, 3))),
            decode=lambda ids, skip_special_tokens: " Polished text. ")
        worker.magic_model_name = "qwen35Small"
        worker.magic_device = "cpu"
        return worker

    def test_failed_warmup_generation_resets_warmup_for_the_next_attempt(self):
        def failing(**kwargs):
            raise RuntimeError("kernel failed")

        worker = self.loaded_worker(failing)
        with patch.dict(sys.modules, {"torch": self.fake_torch()}), patch.object(engine, "emit_progress"):
            with self.assertRaisesRegex(RuntimeError, "kernel failed"):
                worker.generate_rewrite({"text": "hello", "warmup": True})
            self.assertEqual(worker.magic_warmup, "not-started")
            worker.magic_model.generate = lambda **kwargs: [[1, 2, 3, 4, 5, 6]]
            result = worker.generate_rewrite({"text": "hello", "warmup": True})
        self.assertEqual(result["text"], "Polished text.")
        self.assertEqual(worker.magic_warmup, "complete")

    def test_checkpoints_are_downloaded_at_their_pinned_revisions(self):
        self.assertEqual(sorted(engine.MAGIC_REVISIONS), sorted(engine.MAGIC_MODELS.values()))
        self.assertEqual(engine.MAGIC_REVISIONS, {
            "Qwen/Qwen3.5-0.8B": "2fc06364715b967f1860aea9cf38778875588b17",
            "Qwen/Qwen3.5-2B": "15852e8c16360a2fea060d615a32b45270f8a8fc",
            "microsoft/Phi-4-mini-instruct": "cfbefacb99257ffa30c83adab238a50856ac3083",
        })
        snapshot = MagicMock(return_value="/cache/model")

        class FakeModel:
            def eval(self):
                return self

        hub = types.ModuleType("huggingface_hub")
        hub.snapshot_download = snapshot
        transformers = types.ModuleType("transformers")
        transformers.AutoTokenizer = transformers.AutoProcessor = SimpleNamespace(from_pretrained=lambda *a, **k: object())
        transformers.AutoModelForCausalLM = transformers.AutoModelForMultimodalLM = SimpleNamespace(from_pretrained=lambda *a, **k: FakeModel())
        progress = types.ModuleType("download_progress")
        progress.download_progress_class = lambda: None
        modules = {"torch": self.fake_torch(), "huggingface_hub": hub, "transformers": transformers,
                   "download_progress": progress}
        with patch.dict(sys.modules, modules), patch.dict(os.environ), patch.object(engine, "emit_progress"):
            os.environ.pop("HF_HUB_OFFLINE", None)
            os.environ.pop("TRANSFORMERS_OFFLINE", None)
            for model_name, repo in engine.MAGIC_MODELS.items():
                snapshot.reset_mock()
                engine.Worker().load_magic({"model": model_name})
                self.assertEqual(snapshot.call_args.kwargs["repo_id"], repo)
                self.assertEqual(snapshot.call_args.kwargs["revision"], engine.MAGIC_REVISIONS[repo])


if __name__ == "__main__":
    unittest.main()
